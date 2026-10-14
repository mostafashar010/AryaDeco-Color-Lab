"""Bounded authenticated transport; acknowledgements are never measurements."""
import asyncio
import json
import secrets
import time
from collections import deque

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from .models import Capabilities, Envelope, Heartbeat, Join, PatchSet, Reason, Rendered, Resume

MAX_MESSAGE = 65536
HEARTBEAT_SECONDS = 30
EVENT_MODELS = {"capabilities.report": Capabilities, "display.patch.set": PatchSet,
                "display.patch.rendered": Rendered, "session.pause": Reason,
                "session.resume": Resume, "profile.invalidate": Reason, "heartbeat": Heartbeat}


def pause(s, reason):
    if s.get("diagnosticLog"):
        from .models import DiagnosticEvent
        try:
            DiagnosticEvent.model_validate({"sequence": 1, "elapsedMs": 0., "area": "server", "event": "pause", "details": {"reason": reason}})
        except ValueError:
            reason_code = "unclassified"
        else:
            reason_code = reason
        s["diagnosticLog"]("pause", {"reason": reason_code})
    s["lifecycleRevision"] = s.get("lifecycleRevision", 0) + 1
    if s.get("previewStreamId"):
        s.setdefault("retiredPreviewStreams", set()).add(s["previewStreamId"])
    s.update(previewStreamId=None, previewFrame=None)
    s.update(paused=True, pauseReason=reason, currentPatch=None)
    s["runs"].clear()
    s["commands"].clear()
    for device in s.get("devices", {}).values():
        queue = device["queue"]
        while not queue.empty():
            queue.get_nowait()


def invalidate(s, reason):
    pause(s, reason)
    s.update(cameraProfile=None, displayProfile=None, measurements=[], witnesses=None, cameraWitnesses={}, displayCardWitness=None, state="reference")
    s["profileVersion"] += 1


def invalidate_display(s, reason):
    pause(s, reason)
    s.update(displayProfile=None, witnesses=None, displayCardWitness=None)
    s["profileVersion"] += 1
    if s["cameraProfile"] and s["mode"] == "threeStage":
        s["state"] = "display"
    for measurement in s["measurements"]:
        measurement.update(displayStatus="invalidated", displayDriveRgb=None)
        measurement.pop("displayMatch", None)


def command(s, drive, patch_id, layout="single", sample_ids=None, patches=None, *, preview=None):
    if s["paused"] or "display" not in s["devices"]:
        raise ValueError("session_paused_or_display_missing")
    if s["commandSequence"] >= 16777215:
        raise ValueError("marker_sequence_exhausted")
    superseded = [sequence for sequence, previous in s["commands"].items()
                  if previous.get("purpose") == "cameraAppearancePreview"]
    if len(s["commands"]) - len(superseded) >= 64:
        raise ValueError("command_history_limit")
    # A superseded preview can never receive a current-render ACK; retire it anyway.
    for sequence in superseded:
        del s["commands"][sequence]
    s["commandSequence"] += 1
    s["lifecycleRevision"] = s.get("lifecycleRevision", 0) + 1
    patch = dict(profileVersion=s["profileVersion"], patchId=patch_id,
                 displayDriveRgb=drive, layout=layout, sampleIds=sample_ids or [],
                 commandSequence=s["commandSequence"], markerSequence=s["commandSequence"],
                 rendered=False)
    if layout == "group":
        patch.update(patches=patches, groupStatus="unverified")
    if layout == "liveBands":
        patch.update(preview, purpose="cameraAppearancePreview")
    s["currentPatch"] = patch
    s["commands"][s["commandSequence"]] = {**patch, "issuedAt": time.monotonic()}
    return patch


def decode_marker(cells):
    if not cells or len(cells) != 28:
        raise ValueError("marker_samples_required")
    bits = []
    for cell in cells:
        if len(cell) != 3 or any(not 0 <= value <= 1 for value in cell):
            raise ValueError("invalid_marker_cell")
        value = sum(cell) / 3
        if .2 < value < .8:
            raise ValueError("ambiguous_marker_cell")
        bits.append(int(value >= .8))
    if bits[:4] != [0, 1, 0, 1]:
        raise ValueError("invalid_marker_sentinel")
    result = 0
    for bit in bits[4:]:
        result = (result << 1) | bit
    if result == 0:
        raise ValueError("invalid_marker_sequence")
    return result


async def emit(s, event, payload, roles=None):
    for role, device in list(s["devices"].items()):
        if roles is not None and role not in roles:
            continue
        device["serverSequence"] += 1
        envelope = dict(event=event, protocolVersion=1, sessionId=s["sessionId"], role="server",
                        messageId=secrets.token_urlsafe(12), sequenceId=device["serverSequence"], payload=payload)
        queue = device["queue"]
        if event == "display.patch.set" and payload.get("layout") == "liveBands" and payload.get("purpose") == "cameraAppearancePreview":
            retained = []
            # No await here: coalescing is atomic on this event loop, preserving control order.
            while not queue.empty():
                pending = queue.get_nowait()
                queue.task_done()
                previous = pending.get("payload", {})
                if (pending.get("event") == "display.patch.set" and previous.get("layout") == "liveBands"
                        and previous.get("purpose") == "cameraAppearancePreview"
                        and previous.get("commandSequence", 0) < payload["commandSequence"]):
                    continue
                retained.append(pending)
            for pending in retained:
                queue.put_nowait(pending)
        try:
            queue.put_nowait(envelope)
        except asyncio.QueueFull:
            pause(s, "backpressure")
            device["overflow"].set()


def install(app):
    @app.websocket("/ws/{sid}")
    async def socket(ws: WebSocket, sid: str):
        s = app.state.sessions.get(sid)
        if ws.headers.get("origin") != app.state.origin or ws.query_params or not s:
            await ws.close(code=1008)
            return
        await ws.accept()
        role = None
        device = None
        sender = None
        overflow = None

        async def receive(timeout):
            raw = await asyncio.wait_for(ws.receive_text(), timeout)
            if len(raw.encode()) > MAX_MESSAGE:
                raise ValueError("message_too_large")
            return Envelope.model_validate(json.loads(raw))

        try:
            first = await receive(5)
            if first.event != "device.join" or first.sequenceId != 1 or first.sessionId != sid or first.role == "server":
                raise ValueError("invalid_join")
            role = first.role
            token = Join.model_validate(first.payload).token
            if time.time() >= s["expiry"] or not secrets.compare_digest(token, s[role + "Token"]):
                raise ValueError("invalid_token")
            if role in s["devices"]:
                raise ValueError("role_already_owned")
            device = dict(queue=asyncio.Queue(maxsize=32), serverSequence=0, overflow=asyncio.Event(), socket=ws)
            s["devices"][role] = device
            # Reconnect requires deliberate camera resumption; never replay old commands.
            pause(s, "device_joined")

            async def send():
                while True:
                    await asyncio.wait_for(ws.send_json(await device["queue"].get()), 5)

            async def overflow_close():
                await device["overflow"].wait()
                await ws.close(code=1013)

            sender = asyncio.create_task(send())
            overflow = asyncio.create_task(overflow_close())
            await emit(s, "session.state", app.state.snapshot(s), [role])
            last_seq = 1
            seen = deque([first.messageId], maxlen=256)
            rates = deque()
            heartbeat_at = time.monotonic()
            while True:
                timeout = min(HEARTBEAT_SECONDS - (time.monotonic() - heartbeat_at), s["expiry"] - time.time())
                if timeout <= 0 or app.state.sessions.get(sid) is not s:
                    raise ValueError("heartbeat_or_token_expired")
                msg = await receive(timeout)
                now = time.monotonic()
                rates.append(now)
                while rates and rates[0] < now - 1:
                    rates.popleft()
                if len(rates) > 20:
                    raise ValueError("rate_limit")
                code = None
                if msg.sessionId != sid or msg.role != role:
                    code = "identity_mismatch"
                elif msg.sequenceId <= last_seq or msg.messageId in seen:
                    code = "duplicate_or_sequence"
                else:
                    last_seq = msg.sequenceId
                    seen.append(msg.messageId)
                    if msg.event not in EVENT_MODELS:
                        code = "event_not_allowed"
                    elif (msg.event in ("display.patch.set", "session.resume", "profile.invalidate") and role != "camera") or (msg.event == "display.patch.rendered" and role != "display"):
                        code = "role_forbidden"
                if code:
                    await emit(s, "quality.alert", {"code": code}, [role])
                    continue
                try:
                    payload = EVENT_MODELS[msg.event].model_validate(msg.payload)
                    if msg.event == "heartbeat":
                        heartbeat_at = now
                        await emit(s, "heartbeat", payload.model_dump(), [role])
                    elif msg.event == "capabilities.report":
                        previous = s["capabilities"].get(role)
                        s["capabilities"][role] = payload.model_dump()
                        if previous and previous != payload.model_dump():
                            if role == "display":
                                invalidate_display(s, "display_capabilities_changed")
                            else:
                                invalidate(s, "camera_capabilities_changed")
                        await emit(s, "session.state", app.state.snapshot(s))
                    elif msg.event == "session.pause":
                        pause(s, payload.reason)
                        await emit(s, "session.state", app.state.snapshot(s))
                    elif msg.event == "session.resume":
                        if s["mode"] == "threeStage" and "display" not in s["devices"]:
                            raise ValueError("display_missing")
                        s.update(paused=False, pauseReason=None)
                        if s.get("diagnosticLog"):
                            s["diagnosticLog"]("resume", {"role": role})
                        await emit(s, "session.state", app.state.snapshot(s))
                    elif msg.event == "profile.invalidate":
                        invalidate(s, payload.reason)
                        await emit(s, "session.state", app.state.snapshot(s))
                    elif msg.event == "display.patch.set":
                        if payload.profileVersion != s["profileVersion"]:
                            raise ValueError("stale_profile")
                        patch = command(s, payload.displayDriveRgb, payload.patchId, payload.layout, payload.sampleIds,
                                        [p.model_dump() for p in payload.patches] if payload.patches else None)
                        await emit(s, "display.patch.set", patch)
                    elif msg.event == "display.patch.rendered":
                        patch = s["currentPatch"]
                        if not patch or any(patch[k] != getattr(payload, k) for k in ("profileVersion", "patchId", "commandSequence")):
                            raise ValueError("stale_render")
                        patch["rendered"] = True
                        s["commands"][payload.commandSequence]["rendered"] = True
                        if s.get("diagnosticLog"):
                            s["diagnosticLog"]("display.patch.rendered", {"commandSequence": payload.commandSequence})
                        await emit(s, "display.patch.rendered", payload.model_dump())
                except (ValidationError, ValueError) as exc:
                    await emit(s, "quality.alert", {"code": str(exc) if isinstance(exc, ValueError) and not isinstance(exc, ValidationError) else "invalid_payload"}, [role])
        except (WebSocketDisconnect, asyncio.TimeoutError, ValidationError, ValueError, json.JSONDecodeError):
            try:
                await ws.close(code=1008)
            except RuntimeError:
                pass
        finally:
            if sender:
                sender.cancel()
            if overflow:
                overflow.cancel()
            if device and s["devices"].get(role) is device:
                del s["devices"][role]
                pause(s, "device_disconnected")
                await emit(s, "session.state", app.state.snapshot(s))
