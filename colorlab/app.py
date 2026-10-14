"""Single-process v1: ephemeral image state and private bounded software logs."""
import json
import hashlib
import asyncio
import os
import secrets
import time
from datetime import datetime, timezone
from collections import deque
from contextvars import ContextVar
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form
from fastapi.responses import Response, FileResponse, HTMLResponse
from html import escape
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles

from . import models
from .models import SessionCreate, CameraFit, Conditions, Exploratory, ReferenceTarget
from .protocol import EVENT_MODELS, emit, invalidate, invalidate_display, command, decode_marker
from .diagnostics import DiagnosticsStore
from .live_debug import LiveDebugStore


def create_app(*, origin=None, ttl=3600, max_sessions=32, request_rate=60, static_dir=None):
    async def cleanup():
        app.state.live_debug.sweep()
        for sid, s in list(app.state.sessions.items()):
            if "camera" not in s["devices"]:
                app.state.live_debug.stop(sid)
            if time.time() >= s["expiry"]:
                app.state.live_debug.stop(sid)
                for device in list(s["devices"].values()):
                    try:
                        await device["socket"].close(code=1008)
                    except RuntimeError:
                        pass
                s.update(images={}, cameraProfile=None, displayProfile=None, responseProfile=None, measurements=[], references=None,
                         validationReports=[], cameraToken="", displayToken="", cameraWitnesses={}, displayCardWitness=None,
                         witnesses=None, commands={}, usedFrames=set(), usedVideoFrames=set(), currentPatch=None, conditions={}, capabilities={})
                s["runs"].clear()
                app.state.sessions.pop(sid, None)

    @asynccontextmanager
    async def lifespan(app):
        async def sweep():
            while True:
                await asyncio.sleep(1)
                await cleanup()
        task = asyncio.create_task(sweep())
        try:
            yield
        finally:
            task.cancel()
            for s in app.state.sessions.values():
                s["expiry"] = 0
            await cleanup()

    app = FastAPI(lifespan=lifespan)
    app.state.sessions = {}
    app.state.origin = origin or os.getenv("COLORLAB_ORIGIN", "http://localhost:8443")
    app.state.ttl = ttl
    app.state.max_sessions = max_sessions
    app.state.engine_busy = False
    data_dir = Path(os.getenv("COLORLAB_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data")))
    app.state.diagnostics = DiagnosticsStore(data_dir / "diagnostics")
    app.state.live_debug = LiveDebugStore(data_dir / "live-debug")
    global_rates = deque()
    operation = ContextVar("colorlab_operation", default=None)

    def server_event(s, event, details=None, request_id=None):
        if not s.get("diagnosticsEnabled") or s.get("diagnosticsDeleted"):
            return
        try:
            safe = models.DiagnosticEvent.model_validate({"sequence": 1, "elapsedMs": 0., "area": "server",
                                                         "event": event, "details": details or {}})
            row = safe.model_dump(exclude={"sequence", "elapsedMs"})
            row["recordedAt"] = datetime.now(timezone.utc).isoformat()
            if request_id:
                row["requestId"] = request_id
            app.state.diagnostics.append(s["diagnosticId"], [row])
            evidence = safe.details.get("evidenceSnapshot")
            if evidence:
                s.setdefault("latestEvidence", {}).setdefault(evidence["role"], {})[evidence["stage"]] = evidence
        except (OSError, ValueError):
            s["diagnosticsStorageStatus"] = "unavailable"

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": [{"loc": e["loc"], "msg": e["msg"], "type": e["type"]} for e in exc.errors()]}, status_code=422)

    @app.middleware("http")
    async def guard(request, call_next):
        # Auth handles expiry for its own route; all other requests also sweep privacy data.
        route_parts = request.url.path.split("/")
        target = route_parts[3] if len(route_parts) > 3 and route_parts[2] == "sessions" else None
        expired_target = app.state.sessions.get(target)
        target_expired = expired_target is not None and time.time() >= expired_target["expiry"]
        await cleanup()
        if target_expired:
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "token_expired"}, status_code=401)
        if request.url.path.startswith("/api/") and request.url.path not in ("/api/health", "/api/schema"):
            supplied_origin = request.headers.get("origin")
            if (supplied_origin is not None and supplied_origin != app.state.origin) or (request.method not in ("GET", "HEAD") and supplied_origin != app.state.origin):
                from fastapi.responses import JSONResponse
                return JSONResponse({"detail": "origin_mismatch"}, status_code=403)
        if request.url.path.startswith("/api/"):
            from fastapi.responses import JSONResponse
            now = time.monotonic()
            while global_rates and global_rates[0] < now - 1:
                global_rates.popleft()
            if len(global_rates) >= 120:
                return JSONResponse({"detail": "request_rate_limit"}, status_code=429)
            global_rates.append(now)
            parts = request.url.path.split("/")
            s = app.state.sessions.get(parts[3]) if len(parts) > 3 and parts[2] == "sessions" else None
            if s:
                rates = s["requestTimes"]
                while rates and rates[0] < now - 1:
                    rates.popleft()
                if len(rates) >= request_rate:
                    return JSONResponse({"detail": "session_request_rate_limit"}, status_code=429)
                rates.append(now)
            limit = 65536 if request.url.path.endswith(("/diagnostics", "/live-preview")) else 16 * 1024 * 1024
            if len(parts) > 4 and parts[4] == "live-debug":
                limit = LiveDebugStore.max_upload_bytes + 16384 if parts[5:] == ["frames"] else 65536
            length = request.headers.get("content-length")
            if length and (not length.isdigit() or int(length) > limit):
                return JSONResponse({"detail": "body_too_large"}, status_code=413)
            # Buffer at most the configured limit, including chunked/multipart bodies.
            body = bytearray()
            async for chunk in request.stream():
                if len(body) + len(chunk) > limit:
                    return JSONResponse({"detail": "body_too_large"}, status_code=413)
                body.extend(chunk)
            request._body = bytes(body)
        return await call_next(request)

    def get_session(request, sid):
        s = app.state.sessions.get(sid)
        if s is None:
            raise HTTPException(404, "session_not_found")
        if time.time() >= s["expiry"]:
            del app.state.sessions[sid]
            raise HTTPException(401, "token_expired")
        token = request.headers.get("authorization", "")
        if not secrets.compare_digest(token, "Bearer " + s["cameraToken"]):
            raise HTTPException(401, "camera_token_required")
        operation.set((s, s["profileVersion"], s["lifecycleRevision"]))
        return s

    def snapshot(s):
        result = {k: s[k] for k in ("sessionId", "mode", "state", "profileVersion", "capabilities",
                "conditions", "references", "cameraProfile", "displayProfile", "measurements",
                "currentPatch", "paused", "pauseReason", "diagnosticId", "diagnosticsEnabled")}
        if s["mode"] == "cameraMatch":
            result["state"] = "fabric"
        result["captures"] = [{"id": cid, "captureId": cid, "width": image["rgb"].shape[1], "height": image["rgb"].shape[0],
                               "metadata": image["metadata"], "originalRetained": image["original"] is not None,
                               "retention": "ephemeral", "provenance": "explicitUploadApproximateReplay"}
                              for cid, image in s["images"].items()]
        result["validationReports"] = s["validationReports"]
        response_profile = s.get("responseProfile")
        if response_profile and (s["paused"] or response_profile["profileVersion"] != s["profileVersion"]
                or response_profile["conditions"] != s["conditions"] or response_profile["capabilities"] != s["capabilities"]
                or time.time() >= response_profile.get("expiresAt", 0)):
            s["responseProfile"] = None
            s["neutralCheck"] = None
        neutral_context = s.get("neutralContext")
        if s["paused"] or (neutral_context and (neutral_context["conditions"] != s["conditions"] or neutral_context["capabilities"] != s["capabilities"]
                or neutral_context["profileVersion"] != s["profileVersion"])):
            s["neutralCheck"] = None
        result["neutralCheck"] = s.get("neutralCheck")
        result["responseProfile"] = s.get("responseProfile")
        return result

    app.state.get_session = get_session
    app.state.snapshot = snapshot

    @app.get("/api/health")
    def health():
        return {"status": "ok", "storage": "ephemeral", "singleProcess": True}

    def public_ca():
        configured = os.getenv("COLORLAB_PHONE_CA")
        return Path(configured) if configured and Path(configured).is_file() else None

    @app.get("/api/connection-info")
    def connection_info():
        return {"origin": app.state.origin, "https": app.state.origin.startswith("https://"), "phoneSetupUrl": "/phone-setup", "publicCaAvailable": public_ca() is not None}

    @app.get("/phone-root-ca.crt")
    def download_public_ca():
        path = public_ca()
        if path is None:
            raise HTTPException(404, "public_ca_not_configured")
        return FileResponse(path, media_type="application/x-x509-ca-cert", filename="AryaDeco-Color-Lab-CA.crt", headers={"Cache-Control": "no-store"})

    @app.get("/phone-setup", response_class=HTMLResponse)
    def phone_setup():
        origin = escape(app.state.origin, quote=True)
        download = '<a href="/phone-root-ca.crt">دریافت گواهی عمومی برای نصب روی گوشی</a>' if public_ca() else '<p>گواهی عمومی محلی در این اجرا تنظیم نشده است.</p>'
        return HTMLResponse(f'''<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>اتصال گوشی به Color Lab</title><style>body{{font:18px sans-serif;line-height:1.9;max-width:800px;margin:40px auto;padding:20px;background:#18211d;color:#eef5f1}}a{{color:#8ee8b9}}code{{direction:ltr;display:inline-block}}</style><h1>راه‌اندازی یک‌بارهٔ دو گوشی</h1><p>هر دو گوشی و لپ‌تاپ به یک شبکه وصل باشند. آدرس برنامه: <a href="{origin}"><code>{origin}</code></a></p>{download}<ol><li>فقط گواهی عمومی CA را نصب کنید؛ هیچ فایل key به گوشی منتقل نکنید.</li><li>Android: در تنظیمات امنیت، نصب گواهی CA کاربر را انتخاب کنید. مسیر دقیق با نسخه و سازنده متفاوت است.</li><li>iPhone: پروفایل دانلودشده را نصب کنید، سپس در Settings → General → About → Certificate Trust Settings اعتماد کامل به همین CA را فعال کنید.</li><li>برنامه را دوباره باز کنید. مجوز دوربین فقط وقتی اتصال مورد اعتماد و محیط امن باشد قابل استفاده است.</li></ol><p>عبور موقت از هشدار مرورگر فقط برای دریافت گواهی، تأیید امن‌بودن یا فعال‌بودن دوربین نیست. گواهی را از همین لپ‌تاپ مورد اعتماد بگیرید؛ fingerprint آن در ترمینال اجرا چاپ می‌شود. نصب CA اختیار اعتماد دارد؛ فقط برای آزمایش محلی استفاده و پس از عدم نیاز حذف شود.</p><p>روشنایی، قفل سخت‌افزار و سازگاری گوشی با نصب گواهی تأیید نمی‌شوند.</p></html>''', headers={"Cache-Control": "no-store"})

    @app.post("/api/sessions")
    def create(body: SessionCreate):
        for sid, s in list(app.state.sessions.items()):
            if time.time() >= s["expiry"]:
                del app.state.sessions[sid]
        if len(app.state.sessions) >= app.state.max_sessions:
            raise HTTPException(429, "session_limit")
        sid = secrets.token_urlsafe(18)
        expiry = time.time() + app.state.ttl
        s = dict(sessionId=sid, mode=body.mode, conditions=body.conditions, expiry=expiry,
                 cameraToken=secrets.token_urlsafe(32), displayToken=secrets.token_urlsafe(32),
                 expiresAt=datetime.fromtimestamp(expiry, timezone.utc).isoformat(),
                  state="fabric" if body.mode == "cameraMatch" else "reference", profileVersion=0, capabilities={}, references=None,
                  cameraProfile=None, displayProfile=None, responseProfile=None, measurements=[], currentPatch=None,
                 paused=True, pauseReason="awaiting_devices", devices={}, commandSequence=0,
                  images={}, runs={}, usedFrames=set(), usedVideoFrames=set(), witnesses=None, cameraWitnesses={}, displayCardWitness=None, commands={}, validationReports=[], requestTimes=deque(), lifecycleRevision=0)
        s.update(diagnosticId="test-" + secrets.token_hex(12), diagnosticsEnabled=body.diagnosticsEnabled,
                 diagnosticSequence=0, diagnosticReceived=0)
        s["diagnosticLog"] = lambda event, details=None: server_event(s, event, details)
        app.state.sessions[sid] = s
        server_event(s, "created", {"mode": s["mode"]})
        return {k: s[k] for k in ("sessionId", "cameraToken", "displayToken", "expiresAt", "state", "profileVersion", "diagnosticId", "diagnosticsEnabled")}

    @app.get("/api/sessions/{sid}")
    def get(sid: str, request: Request):
        return snapshot(get_session(request, sid))

    @app.delete("/api/sessions/{sid}")
    async def delete(sid: str, request: Request):
        s = get_session(request, sid)
        app.state.live_debug.stop(sid)
        app.state.diagnostics.delete(s["diagnosticId"])
        s["diagnosticsDeleted"] = True
        s["expiry"] = 0
        for device in list(s["devices"].values()):
            await device["socket"].close(code=1000)
        from .protocol import pause
        pause(s, "deleted")
        s.update(cameraProfile=None, displayProfile=None, responseProfile=None, references=None, images={}, measurements=[], validationReports=[],
                 cameraWitnesses={}, displayCardWitness=None, witnesses=None, cameraToken="", displayToken="", conditions={}, capabilities={})
        del app.state.sessions[sid]
        return {"deleted": True}

    def diagnostics_summary(s):
        return {"diagnosticId": s["diagnosticId"], "enabled": s["diagnosticsEnabled"],
                "receivedEvents": s["diagnosticReceived"], "lastClientSequence": s["diagnosticSequence"],
                "bytes": app.state.diagnostics.size(s["diagnosticId"]), "containsImages": False,
                "storageStatus": s.get("diagnosticsStorageStatus", "available"),
                "latestEvidence": s.get("latestEvidence", {})}

    @app.post("/api/sessions/{sid}/diagnostics")
    async def diagnostics(sid: str, request: Request, body: models.DiagnosticsInput):
        s = app.state.sessions.get(sid)
        display_upload = bool(s and time.time() < s["expiry"] and "display" in s["devices"]
            and secrets.compare_digest(request.headers.get("authorization", ""), "Bearer " + s["displayToken"]))
        if not display_upload:
            s = get_session(request, sid)
        role = "display" if display_upload else "camera"
        for event in body.events:
            evidence = event.details.get("evidenceSnapshot")
            if evidence and evidence["role"] != role:
                raise HTTPException(403, "diagnostic_role_mismatch")
            if display_upload and (event.event != "evidence" or not evidence or evidence["stage"] != "rendered"
                    or evidence.get("renderedProof") != "twoAnimationFrames" or evidence.get("physicalAccuracyVerified") is not False):
                raise HTTPException(403, "diagnostic_display_render_evidence_required")
        if not s["diagnosticsEnabled"]:
            raise HTTPException(409, "diagnostics_disabled")
        if any(a.sequence >= b.sequence for a, b in zip(body.events, body.events[1:])):
            raise HTTPException(409, "diagnostic_sequence_reused")
        sequence_key = "displayDiagnosticSequence" if display_upload else "diagnosticSequence"
        fresh_events = [event for event in body.events if event.sequence > s.get(sequence_key, 0)]
        if fresh_events:
            try:
                app.state.diagnostics.append(s["diagnosticId"], [event.model_dump() for event in fresh_events])
            except OSError as exc:
                s["diagnosticsStorageStatus"] = "unavailable"
                raise HTTPException(503, "diagnostics_storage_unavailable") from exc
            s["diagnosticsStorageStatus"] = "available"
            s[sequence_key] = fresh_events[-1].sequence
            s["diagnosticReceived"] += len(fresh_events)
            for event in fresh_events:
                evidence = event.details.get("evidenceSnapshot")
                if evidence:
                    s.setdefault("latestEvidence", {}).setdefault(evidence["role"], {})[evidence["stage"]] = evidence
        if display_upload:
            return {"enabled": s["diagnosticsEnabled"], "accepted": len(fresh_events),
                    "lastClientSequence": s.get(sequence_key, 0)}
        return {**diagnostics_summary(s), "accepted": len(fresh_events)}

    @app.patch("/api/sessions/{sid}/diagnostics")
    async def diagnostics_settings(sid: str, request: Request, body: models.DiagnosticsSettings):
        s = get_session(request, sid)
        s["diagnosticsEnabled"] = body.enabled
        await emit(s, "session.state", snapshot(s))
        return diagnostics_summary(s)

    @app.get("/api/sessions/{sid}/diagnostics/summary")
    def diagnostic_summary(sid: str, request: Request):
        return diagnostics_summary(get_session(request, sid))

    def live_debug_session(request, sid):
        s = app.state.sessions.get(sid)
        if s and secrets.compare_digest(request.headers.get("authorization", ""), "Bearer " + s["displayToken"]):
            raise HTTPException(403, "live_debug_camera_only")
        return get_session(request, sid)

    @app.post("/api/sessions/{sid}/live-debug")
    def live_debug_settings(sid: str, request: Request, body: models.LiveDebugSettings):
        s = live_debug_session(request, sid)
        if body.enabled:
            if not body.consent:
                raise HTTPException(400, "live_debug_consent_required")
            if "camera" not in s["devices"]:
                raise HTTPException(409, "live_debug_active_camera_required")
            result = app.state.live_debug.start(sid, s["diagnosticId"], s["expiry"])
            server_event(s, "enabled")
            return result
        app.state.live_debug.stop(sid)
        server_event(s, "disabled")
        return app.state.live_debug.status(sid, s["diagnosticId"])

    @app.get("/api/sessions/{sid}/live-debug/status")
    def live_debug_status(sid: str, request: Request):
        s = live_debug_session(request, sid)
        return app.state.live_debug.status(sid, s["diagnosticId"])

    @app.post("/api/sessions/{sid}/live-debug/frames")
    async def live_debug_frame(sid: str, request: Request, file: UploadFile = File(...), metadata: str = Form("{}")):
        live_debug_session(request, sid)
        form = await request.form()
        keys = [key for key, _ in form.multi_items()]
        if any(key not in ("file", "metadata") for key in keys) or len(keys) != len(set(keys)):
            raise HTTPException(422, "live_debug_invalid_multipart")
        def unique_keys(pairs):
            result = dict(pairs)
            if len(result) != len(pairs):
                raise ValueError("duplicate_metadata_key")
            return result
        try:
            if len(metadata) > 8192:
                raise ValueError("metadata_size_limit")
            safe = models.LiveDebugMetadata.model_validate(json.loads(metadata, object_pairs_hook=unique_keys)).model_dump(exclude_none=True)
        except ValueError as exc:
            raise HTTPException(422, "live_debug_invalid_metadata") from exc
        try:
            return app.state.live_debug.append(sid, await file.read(LiveDebugStore.max_upload_bytes + 1), safe, file.content_type)
        except OSError as exc:
            raise HTTPException(503, "live_debug_storage_unavailable") from exc

    @app.get("/api/sessions/{sid}/live-debug/frames/latest")
    def live_debug_latest(sid: str, request: Request):
        live_debug_session(request, sid)
        try:
            data = app.state.live_debug.latest(sid)
        except OSError as exc:
            raise HTTPException(503, "live_debug_storage_unavailable") from exc
        return Response(data, media_type="image/png",
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    @app.middleware("http")
    async def software_diagnostics(request, call_next):
        started = time.monotonic()
        request_id = secrets.token_urlsafe(18)
        parts = request.url.path.split("/")
        s = app.state.sessions.get(parts[3]) if len(parts) > 3 and parts[1:3] == ["api", "sessions"] else None
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        if len(parts) > 4 and parts[4] == "live-debug":
            response.headers["Cache-Control"] = "no-store"
        if s and s["diagnosticsEnabled"] and app.state.sessions.get(s["sessionId"]) is s:
            known = {"conditions", "reference", "camera-profile", "display-profile", "response-profile", "matches", "camera-matches", "live-preview", "measurements", "captures", "images", "export", "validations", "diagnostics"}
            endpoint = parts[4] if len(parts) > 4 and parts[4] in known else "session"
            # Route classes only: IDs, query strings, headers and bodies never enter logs.
            if endpoint != "diagnostics":
                server_event(s, "response", {"method": request.method, "endpoint": endpoint, "status": response.status_code,
                    "elapsedMs": round((time.monotonic() - started) * 1000, 3)}, request_id)
        return response

    @app.get("/api/schema")
    def schema():
        entities = {name: value.model_json_schema() for name, value in vars(models).items()
                    if isinstance(value, type) and issubclass(value, models.StrictModel) and value is not models.StrictModel}
        return {"version": 1, "protocolVersion": 1, "entities": entities,
                "events": {"device.join": models.Join.model_json_schema(),
                           **{name: cls.model_json_schema() for name, cls in EVENT_MODELS.items()},
                           **{name: {"direction": "server"} for name in (
                               "session.state", "capture.request", "quality.alert", "match.iteration",
                               "match.complete", "measurement.submit", "camera.profile.ready", "reference.set", "export.request")}}
                }

    @app.patch("/api/sessions/{sid}/conditions")
    async def conditions(sid: str, request: Request, body: Conditions):
        s = get_session(request, sid)
        if s["conditions"] != body.conditions:
            changed = {key for key in set(s["conditions"]) | set(body.conditions) if s["conditions"].get(key) != body.conditions.get(key)}
            s["conditions"] = body.conditions
            s.update(responseProfile=None, neutralCheck=None)
            if changed <= {"display", "displayBrightness", "displayColorMode", "displayNightShift", "displayLayout"}:
                invalidate_display(s, "display_conditions_changed")
            else:
                invalidate(s, "conditions_changed")
        await emit(s, "session.state", snapshot(s))
        return snapshot(s)

    @app.post("/api/sessions/{sid}/reference")
    async def reference(sid: str, request: Request, body: ReferenceTarget | Exploratory):
        s = get_session(request, sid)
        if s["mode"] == "cameraMatch":
            raise HTTPException(409, "camera_match_has_no_calibration_stages")
        invalidate(s, "reference_changed")
        s["references"] = body.model_dump()
        s["state"] = "camera"
        await emit(s, "reference.set", s["references"])
        await emit(s, "session.state", snapshot(s))
        return s["references"]

    async def engine_call(name, *args, **kwargs):
        def check_operation():
            context = operation.get()
            if context:
                s, version, revision = context
                if app.state.sessions.get(s["sessionId"]) is not s or s["profileVersion"] != version or s["lifecycleRevision"] != revision or time.time() >= s["expiry"]:
                    raise HTTPException(409, "session_changed_during_processing")
        check_operation()
        if app.state.engine_busy:
            raise HTTPException(429, "engine_busy")
        app.state.engine_busy = True
        try:
            from starlette.concurrency import run_in_threadpool
            from . import engine
            if name.startswith("response:"):
                from . import display_response as engine
                name = name.split(":", 1)[1]
            result = await run_in_threadpool(getattr(engine, name), *args, **kwargs)
            check_operation()
            return result
        except (ValueError, TypeError, KeyError) as exc:
            raise HTTPException(422, str(exc)) from exc
        finally:
            app.state.engine_busy = False

    @app.post("/api/sessions/{sid}/camera-profile")
    async def camera_profile(sid: str, request: Request, body: CameraFit):
        s = get_session(request, sid)
        if s["mode"] == "cameraMatch":
            raise HTTPException(409, "camera_match_has_no_calibration_stages")
        if s["state"] != "camera" or not s["references"]:
            raise HTTPException(409, "reference_stage_required")
        if s["references"].get("exploratory"):
            profile = {"id": secrets.token_urlsafe(12), "status": "exploratory", "matrix": None,
                       "trainingPatchIds": [], "holdoutPatchIds": [], "validation": None}
        else:
            all_frames = [f for o in body.observations for f in o.frames]
            fresh(s, all_frames, fingerprint=body.fingerprint)
            if any(f.source != "videoCanvas" for f in all_frames):
                raise HTTPException(422, "physical_camera_captures_required")
            profile = await engine_call("fit_camera", s["references"], [o.model_dump() for o in body.observations])
            fresh(s, all_frames, consume=True)
            s["cameraWitnesses"] = {o.patchId: [f.model_dump() for f in o.frames] for o in body.observations}
        s["profileVersion"] += 1
        s.update(cameraProfile={**profile, "fingerprint": body.fingerprint}, displayProfile=None,
                 measurements=[], state="display" if s["mode"] == "threeStage" else "fabric")
        await emit(s, "camera.profile.ready", s["cameraProfile"])
        await emit(s, "session.state", snapshot(s))
        return s["cameraProfile"]

    def check_command(s, frames, sequence, patch_id, layout, *, current=False):
        cmd = s["commands"].get(sequence)
        if s["paused"] or not cmd or not cmd["rendered"] or cmd["patchId"] != patch_id or cmd["layout"] != layout or cmd["profileVersion"] != s["profileVersion"]:
            raise HTTPException(409, "fresh_rendered_command_required")
        if time.monotonic() - cmd["issuedAt"] > 300:
            raise HTTPException(409, "command_expired")
        if current and (not s["currentPatch"] or s["currentPatch"]["commandSequence"] != sequence):
            raise HTTPException(409, "stale_command")
        for frame in frames:
            if not physical_identity([frame]):
                raise HTTPException(422, "actual_video_identity_required")
            if frame.source != "videoCanvas" or frame.markerSequence != sequence:
                raise HTTPException(422, "live_marker_required")
            try:
                decoded = decode_marker(frame.markerPixels)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            if decoded != sequence:
                raise HTTPException(422, "marker_mismatch")
        return cmd

    @app.post("/api/sessions/{sid}/display-profile")
    async def display_profile(sid: str, request: Request, body: models.DisplayFit):
        s = get_session(request, sid)
        if s["state"] != "display" or not s["cameraProfile"] or s["paused"]:
            raise HTTPException(409, "active_display_stage_required")
        if body.fingerprint != s["cameraProfile"]["fingerprint"]:
            raise HTTPException(409, "settings_fingerprint_changed")
        if not body.contaminationFabricBaseline or not body.contaminationFabricChecks or len(body.contaminationChecks) != len(body.contaminationFabricChecks):
            raise HTTPException(422, "paired_fabric_contamination_test_required")
        drives = []
        for neutral, fabric in [(body.contaminationBaseline, body.contaminationFabricBaseline), *zip(body.contaminationChecks, body.contaminationFabricChecks)]:
            sequence = neutral[0].markerSequence
            cmd = s["commands"].get(sequence)
            if sequence is None or not cmd:
                raise HTTPException(422, "contamination_command_required")
            check_command(s, neutral + fabric, sequence, cmd["patchId"], "single")
            if len(neutral) != len(fabric) or any(abs(a.capturedAt - b.capturedAt) > 100 or (a.mediaTime is not None and b.mediaTime is not None and a.mediaTime != b.mediaTime) or (a.presentedFrames is not None and b.presentedFrames is not None and a.presentedFrames != b.presentedFrames) for a, b in zip(neutral, fabric)):
                raise HTTPException(422, "co_captured_contamination_required")
            drives.append(cmd["displayDriveRgb"])
        if [0., 0., 0.] not in drives or [1., 1., 1.] not in drives or not any(max(d) - min(d) >= .2 for d in drives):
            raise HTTPException(422, "black_white_colored_contamination_commands_required")
        all_frames = list(body.contaminationBaseline)
        for check in body.contaminationChecks:
            all_frames.extend(check)
        observations = []
        baseline = await summary(body.contaminationBaseline)
        if baseline["quality"]["status"] != "accepted":
            raise HTTPException(422, "contamination_baseline_rejected")
        for observation in body.observations:
            if not observation.cardFrames or not observation.cardPatchId:
                raise HTTPException(422, "actual_card_pairing_required")
            cmd = check_command(s, observation.frames, observation.commandSequence, observation.patchId, "single")
            if cmd["displayDriveRgb"] != observation.drive:
                raise HTTPException(422, "command_drive_mismatch")
            all_frames.extend(observation.frames)
            all_frames.extend(observation.witnessFrames)
            if observation.cardFrames:
                all_frames.extend(observation.cardFrames)
            response = await summary(observation.frames)
            witness = await summary(observation.witnessFrames)
            if response["quality"]["status"] != "accepted" or witness["quality"]["status"] != "accepted":
                raise HTTPException(422, "display_capture_quality_rejected")
            if not await engine_call("check_witness", [f.model_dump() for f in body.contaminationBaseline], [f.model_dump() for f in observation.witnessFrames]):
                raise HTTPException(422, "unstable_witness")
            observations.append(observation.model_dump())
        for check in body.contaminationChecks:
            witness = await summary(check)
            if witness["quality"]["status"] != "accepted" or not await engine_call("check_witness", [f.model_dump() for f in body.contaminationBaseline], [f.model_dump() for f in check]):
                raise HTTPException(422, "display_contamination_rejected")
        if not body.contaminationFabricBaseline or not body.contaminationFabricChecks:
            raise HTTPException(422, "fabric_contamination_test_required")
        fabric_base = await summary(body.contaminationFabricBaseline)
        if fabric_base["quality"]["status"] != "accepted":
            raise HTTPException(422, "fabric_contamination_baseline_rejected")
        all_frames.extend(body.contaminationFabricBaseline)
        for check in body.contaminationFabricChecks:
            all_frames.extend(check)
            if not await engine_call("check_witness", [f.model_dump() for f in body.contaminationFabricBaseline], [f.model_dump() for f in check]):
                raise HTTPException(422, "fabric_contamination_rejected")
        fresh(s, all_frames, fingerprint=body.fingerprint)
        if any(f.source != "videoCanvas" for f in all_frames):
            raise HTTPException(422, "physical_witness_required")
        if len({o.commandSequence for o in body.observations}) != len(body.observations):
            raise HTTPException(422, "unique_display_commands_required")
        profile = await engine_call("fit_display", observations)
        fresh(s, all_frames, consume=True)
        s["profileVersion"] += 1
        s.update(displayProfile={**profile, "fingerprint": body.fingerprint,
                                 "status": "CameraReferencedDisplayCompensationProfile",
                                 "cameraReferenced": s["cameraProfile"].get("status") == "referenced",
                                 "contaminationStatus": "neutralAndFabricPassed",
                                 "physicalAccuracyVerified": False}, witnesses=[f.model_dump() for f in body.contaminationBaseline], state="fabric",
                  currentPatch=None, commands={})
        s["displayCardWitness"] = {"patchId": body.observations[0].cardPatchId, "frames": [f.model_dump() for f in body.observations[0].cardFrames]}
        await emit(s, "session.state", snapshot(s))
        return s["displayProfile"]

    @app.post("/api/sessions/{sid}/matches")
    async def match_start(sid: str, request: Request, body: models.MatchStart):
        s = get_session(request, sid)
        if s["state"] != "fabric" or not s["displayProfile"] or s["paused"] or s["witnesses"] is None:
            raise HTTPException(409, "active_display_profile_required")
        if s["runs"]:
            raise HTTPException(409, "match_already_active")
        m = next((m for m in s["measurements"] if m["id"] == body.measurementId), None)
        if not m or m["quality"]["status"] != "accepted":
            raise HTTPException(422, "accepted_measurement_required")
        from .engine import BoundedMatch
        run_id = secrets.token_urlsafe(12)
        initial = [0.5, 0.5, 0.5]
        loop = BoundedMatch(m["linearRgb"], initial, body.noiseFloor, body.maxEvaluations, body.target)
        try:
            patch = command(s, initial, secrets.token_urlsafe(12))
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        s["runs"][run_id] = {"loop": loop, "measurementId": m["id"], "noiseFloor": body.noiseFloor,
                                "commandSequence": patch["commandSequence"], "patchId": patch["patchId"]}
        await emit(s, "display.patch.set", patch)
        await emit(s, "capture.request", {"runId": run_id, **patch})
        return {"runId": run_id, "nextDrive": initial, "status": "running",
                "patchId": patch["patchId"], "commandSequence": patch["commandSequence"]}

    def active_camera_match(s):
        if s["mode"] != "cameraMatch" or s["paused"] or not {"camera", "display"} <= s["devices"].keys():
            raise HTTPException(409, "active_owned_camera_and_display_required")

    async def response_command(s, run_id, run):
        step = run["steps"][run["index"]]
        try:
            patch = command(s, step["drive"], secrets.token_urlsafe(12))
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        run.update(commandSequence=patch["commandSequence"], patchId=patch["patchId"])
        output = {"runId": run_id, "nextDrive": step["drive"], "phase": step["phase"],
                  "step": run["index"] + 1, "totalSteps": len(run["steps"]), "status": "running",
                  "patchId": patch["patchId"], "commandSequence": patch["commandSequence"]}
        await emit(s, "display.patch.set", patch)
        await emit(s, "capture.request", {**patch, **output, "purpose": "responseCharacterization"})
        return output

    @app.post("/api/sessions/{sid}/response-profile/start")
    async def response_start(sid: str, request: Request, body: models.ResponseStart):
        s = get_session(request, sid)
        active_camera_match(s)
        if s["runs"]:
            raise HTTPException(409, "match_already_active")
        if s.get("previewStreamId"):
            raise HTTPException(409, "preview_must_pause_before_response")
        from .display_response import response_steps
        if s.get("previewStreamId"):
            s.setdefault("retiredPreviewStreams", set()).add(s["previewStreamId"])
        s.update(previewStreamId=None, previewFrame=None, responseProfile=None, neutralCheck=None)
        run_id = secrets.token_urlsafe(12)
        steps = response_steps()
        middle = steps[1:9]
        secrets.SystemRandom().shuffle(middle)
        steps[1:9] = middle
        run = {**body.model_dump(), "mode": "responseCharacterization", "steps": steps, "index": 0,
               "observations": [], "signatures": None, "baselineCard": None, "lastPresented": None,
               "lastCapturedAt": None, "referenceRole": None, "lastMediaTime": None}
        s["runs"][run_id] = run
        try:
            return await response_command(s, run_id, run)
        except HTTPException:
            s["runs"].pop(run_id, None)
            raise

    def response_context(s, run, body):
        if any(run[k] != getattr(body, k) for k in ("fingerprint", "width", "height", "streamId")):
            s.update(responseProfile=None, neutralCheck=None)
            raise HTTPException(409, "response_conditions_or_stream_changed")

    async def response_pair(s, body, *, signatures=None):
        return await engine_call("response:paired_relative", [f.model_dump() for f in body.frames],
                                 [f.model_dump() for f in body.cardFrames], fingerprint=body.fingerprint,
                                 width=body.width, height=body.height, signatures=signatures)

    async def response_drift(s, baseline, card):
        try:
            return await engine_call("response:witness_drift", baseline, card)
        except HTTPException as exc:
            if exc.status_code == 422:
                from .protocol import pause
                s["responseProfile"] = None
                pause(s, "response_neutral_witness_drift")
                await emit(s, "session.state", snapshot(s))
            raise

    @app.post("/api/sessions/{sid}/response-profile/{run_id}/observe")
    async def response_observe(sid: str, run_id: str, request: Request, body: models.ResponseObserve):
        s = get_session(request, sid)
        active_camera_match(s)
        run = s["runs"].get(run_id)
        if not run or run.get("mode") != "responseCharacterization":
            raise HTTPException(409, "active_response_run_required")
        response_context(s, run, body)
        step = run["steps"][run["index"]]
        if (body.phase != step["phase"] or body.commandSequence != run["commandSequence"]
                or body.patchId != run["patchId"]):
            raise HTTPException(409, "response_server_step_required")
        all_frames = body.frames + body.cardFrames
        cmd = check_command(s, all_frames, body.commandSequence, body.patchId, "single", current=True)
        if cmd["displayDriveRgb"] != step["drive"]:
            raise HTTPException(409, "response_server_drive_required")
        screen, card = await response_pair(s, body, signatures=run["signatures"])
        if run["lastPresented"] is not None and (body.frames[0].presentedFrames <= run["lastPresented"]
                or body.frames[0].capturedAt <= run["lastCapturedAt"]
                or (run["lastMediaTime"] != 0 and body.frames[0].mediaTime <= run["lastMediaTime"])
                or ((run["lastMediaTime"] == 0) != (screen["quality"]["rawMediaClockState"] == "unavailable"))):
            raise HTTPException(409, "response_callback_reused_or_stale")
        if run["baselineCard"] is not None and body.referenceRole != run["referenceRole"]:
            raise HTTPException(409, "response_reference_role_changed")
        fresh(s, all_frames, fingerprint=body.fingerprint)
        baseline = run["baselineCard"] or card
        drift = await response_drift(s, baseline, card)
        import numpy as np
        # Only small measured shared-neutral ratios are allowed, never moving AWB.
        corrected = np.asarray(screen["rgb"]) * np.asarray(baseline["rgb"]) / np.asarray(card["rgb"])
        observation = {"drive": step["drive"], "phase": step["phase"], "patchId": body.patchId,
                       "commandSequence": body.commandSequence, "rgb": corrected.tolist(),
                       "uncorrectedRgb": screen["rgb"], "cardRgb": card["rgb"], "witnessDrift": drift,
                       "quality": screen["quality"], "cardQuality": card["quality"],
                       "frames": screen["provenance"], "cardFrames": card["provenance"]}
        fresh(s, all_frames, consume=True)
        run["observations"].append(observation)
        run.update(index=run["index"] + 1, baselineCard=baseline, referenceRole=body.referenceRole,
                   signatures=(screen["signature"], card["signature"]), lastPresented=body.frames[-1].presentedFrames,
                   lastCapturedAt=body.frames[-1].capturedAt, lastMediaTime=body.frames[-1].mediaTime)
        del s["commands"][body.commandSequence]
        if run["index"] < len(run["steps"]):
            return await response_command(s, run_id, run)
        profile = await engine_call("response:fit_display_response", run["observations"])
        import copy
        profile.update(fingerprint=run["fingerprint"], width=run["width"], height=run["height"], streamId=run["streamId"],
                       profileVersion=s["profileVersion"], conditions=copy.deepcopy(s["conditions"]),
                       capabilities=copy.deepcopy(s["capabilities"]), referenceRole=run["referenceRole"],
                       expiresAt=min(s["expiry"], time.time() + 600),
                       nativeCanvasColorSpace=screen["quality"]["nativeCanvasColorSpace"],
                       baselineCard={"rgb": baseline["rgb"], "quality": baseline["quality"], "signature": card["signature"]},
                       observations=run["observations"], lastPresented=run["lastPresented"], lastCapturedAt=run["lastCapturedAt"],
                       lastMediaTime=run["lastMediaTime"],
                       rawMediaClockState="unavailable" if any(o["quality"]["rawMediaClockState"] == "unavailable" for o in run["observations"]) else "reported")
        profile["validation"]["maximumObservedWitnessDrift"] = max(o["witnessDrift"]["maxRelativeDrift"] for o in run["observations"])
        if profile["rawMediaClockState"] == "unavailable":
            profile.setdefault("limitations", []).append("rawMediaClockUnavailableCallbackIdentityOnly")
        s.update(responseProfile=profile, currentPatch=None)
        del s["runs"][run_id]
        await emit(s, "session.state", snapshot(s))
        return {"runId": run_id, "nextDrive": None, "status": "complete" if profile["validProfile"] else "invalid", "responseProfile": profile}

    @app.delete("/api/sessions/{sid}/response-profile")
    async def response_cancel(sid: str, request: Request):
        s = get_session(request, sid)
        from .protocol import pause
        pause(s, "response_cancelled")
        s.update(responseProfile=None, neutralCheck=None)
        await emit(s, "session.state", snapshot(s))
        return {"status": "cancelled", "responseProfile": None}

    @app.post("/api/sessions/{sid}/response-profile/invert")
    async def response_invert(sid: str, request: Request, body: models.ResponseTarget):
        s = get_session(request, sid)
        active_camera_match(s)
        profile = snapshot(s).get("responseProfile")
        if not profile or not profile.get("validProfile") or s["runs"]:
            raise HTTPException(409, "active_response_profile_required")
        response_context(s, profile, body)
        target, card = await response_pair(s, body)
        if body.referenceRole != profile["referenceRole"] or card["signature"] != tuple(profile["baselineCard"]["signature"]):
            raise HTTPException(409, "response_reference_geometry_changed")
        if body.frames[0].presentedFrames <= profile["lastPresented"] or body.frames[0].capturedAt <= profile["lastCapturedAt"]:
            raise HTTPException(409, "response_callback_reused_or_stale")
        if ((profile["rawMediaClockState"] == "unavailable") != (target["quality"]["rawMediaClockState"] == "unavailable")
                or (profile["lastMediaTime"] != 0 and body.frames[0].mediaTime <= profile["lastMediaTime"])):
            raise HTTPException(409, "response_media_clock_changed_or_stale")
        all_frames = body.frames + body.cardFrames
        fresh(s, all_frames, fingerprint=body.fingerprint)
        drift = await response_drift(s, profile["baselineCard"], card)
        import numpy as np
        corrected = np.asarray(target["rgb"]) * np.asarray(profile["baselineCard"]["rgb"]) / np.asarray(card["rgb"])
        output = await engine_call("response:invert_response", profile, corrected.tolist())
        if snapshot(s).get("responseProfile") is not profile:
            raise HTTPException(409, "response_valid_profile_required")
        fresh(s, all_frames, consume=True)
        profile.update(lastPresented=body.frames[-1].presentedFrames, lastCapturedAt=body.frames[-1].capturedAt,
                       lastMediaTime=body.frames[-1].mediaTime)
        return {**output, "targetRgb": corrected.tolist(), "uncorrectedTargetRgb": target["rgb"], "witnessDrift": drift,
                "quality": target["quality"], "sourceFrameProvenance": target["provenance"],
                "responseProfileId": profile["id"], "referenceValuesKnown": False, "colorimetricObserver": None}

    @app.post("/api/sessions/{sid}/live-preview")
    async def live_preview(sid: str, request: Request, body: models.LivePreview):
        s = get_session(request, sid)
        active_camera_match(s)
        if s["runs"]:
            raise HTTPException(409, "match_already_active")
        profile = snapshot(s).get("responseProfile")
        if body.compensatedOnly and not profile:
            raise HTTPException(409, "response_valid_profile_required")
        preview_body = body.model_dump()
        preview_body.pop("feedback", None)
        preview_body["cameraAppearanceBands"] = [band.model_dump() for band in body.bands]
        label = "جبران پاسخ نمایشگر از دید دوربین، آزمایشی"
        if profile:
            if (body.fingerprint != profile["fingerprint"] or body.canvasColorSpace != profile["nativeCanvasColorSpace"]
                    or (body.sourceFrame.width, body.sourceFrame.height) != (profile["width"], profile["height"])):
                s.update(responseProfile=None, neutralCheck=None)
                raise HTTPException(409, "response_conditions_or_stream_changed")
            import numpy as np
            results = []
            for band in body.bands:
                encoded = np.asarray(band.drive)
                linear = np.where(encoded <= .04045, encoded / 12.92, ((encoded + .055) / 1.055) ** 2.4)
                if body.cameraAppearanceColorSpace != profile["nativeCanvasColorSpace"]:
                    from .engine import MATRICES
                    # Nominal canvas basis conversion, not a calibrated camera XYZ.
                    linear = linear @ MATRICES[body.cameraAppearanceColorSpace].T @ np.linalg.inv(MATRICES[profile["nativeCanvasColorSpace"]]).T
                results.append(await engine_call("response:compensate_preview", linear.tolist(), profile))
            if snapshot(s).get("responseProfile") is not profile:
                raise HTTPException(409, "response_valid_profile_required")
            unsupported = any(result["drive"] is None for result in results)
            if unsupported and body.compensatedOnly:
                raise HTTPException(422, "response_out_of_support")
            preview_body["bands"] = [{**band.model_dump(), "drive": result["drive"] or band.drive}
                                     for band, result in zip(body.bands, results)]
            if not unsupported:
                preview_body["warnings"] = [warning for warning in preview_body["warnings"] if warning != "uncalibratedPreview"]
            elif "uncalibratedPreview" not in preview_body["warnings"]:
                preview_body["warnings"] = [*preview_body["warnings"], "uncalibratedPreview"][-16:]
            preview_body["compensation"] = {"status": "partiallyCompensatedExperimental" if unsupported else "cameraReferencedExperimental", "label": label,
                                              "responseProfileId": profile["id"], "perBand": [{"id": band.id, **result,
                                                  "status": result["status"] if result["drive"] else "notCompensated"}
                                                  for band, result in zip(body.bands, results)],
                                             "currentNeutralWitnessRechecked": False,
                                             "warnings": ["relativeCameraAppearanceOnly", "previewNeutralWitnessNotRechecked"],
                                             "physicalAccuracyVerified": False, "independentValidationStatus": "notTested"}
        else:
            preview_body["warnings"] = list(dict.fromkeys([*preview_body["warnings"], "uncalibratedPreview"]))[-16:]
            preview_body["compensation"] = {"status": "notCompensated", "label": label, "warnings": ["response_valid_profile_required"]}
        from .preview_feedback import correct_band, same_targets, band_raster_bound
        feedforward_bands = preview_body["bands"]
        feedforward_compensation = preview_body["compensation"]
        previous_patch = s.get("currentPatch")
        prior_feedback = (previous_patch or {}).get("compensation", {}).get("status") == "measuredFeedbackExperimental"
        correction_baseline = ((previous_patch or {}).get("compensation", {}).get("correctionBaseline")
                               if prior_feedback else previous_patch)
        targets_unchanged = same_targets(correction_baseline, preview_body["cameraAppearanceBands"], body.mapping,
                                         body.fingerprint, body.canvasColorSpace, body.cameraAppearanceColorSpace)
        # With no new measurement, retain only camera quantization noise, not a
        # stale drive for a newly observed target. Cumulative baseline stays fixed.
        retain_correction = targets_unchanged and same_targets(correction_baseline, preview_body["cameraAppearanceBands"],
            body.mapping, body.fingerprint, body.canvasColorSpace, body.cameraAppearanceColorSpace, encoded_tolerance=2 / 255)
        if retain_correction and prior_feedback:
            preview_body["bands"] = [{**band.model_dump(), "drive": old["drive"]}
                                     for band, old in zip(body.bands, previous_patch["bands"])]
            preview_body["compensation"] = {**previous_patch["compensation"], "feedbackApplied": False}
        elif prior_feedback and not body.feedback:
            preview_body["compensation"]["warnings"] = [*preview_body["compensation"].get("warnings", []), "previewFeedbackReset"]
        if body.feedback:
            feedback = body.feedback
            if (not previous_patch or not previous_patch.get("rendered") or previous_patch.get("layout") != "liveBands"
                    or previous_patch["commandSequence"] != feedback.commandSequence
                    or previous_patch["patchId"] != feedback.patchId):
                raise HTTPException(409, "preview_feedback_stale_command")
            stored_command = s["commands"].get(feedback.commandSequence)
            if not stored_command or time.monotonic() - stored_command["issuedAt"] > 2.5:
                raise HTTPException(409, "preview_feedback_expired")
            if not body.fingerprint or not body.canvasColorSpace or body.cameraAppearanceColorSpace != "srgb":
                raise HTTPException(422, "preview_feedback_context_required")
            if (previous_patch.get("fingerprint") != body.fingerprint
                    or previous_patch.get("canvasColorSpace") != body.canvasColorSpace):
                raise HTTPException(409, "preview_feedback_context_changed")
            try:
                decoded = decode_marker(feedback.markerPixels)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            if decoded != feedback.commandSequence:
                raise HTTPException(422, "preview_feedback_marker_mismatch")
            ids = [band.id for band in feedback.screenAppearanceBands]
            if ids != previous_patch["sampleIds"] or ids != [band.id for band in body.bands]:
                raise HTTPException(422, "preview_feedback_band_mismatch")
            import numpy as np
            from .engine import _linear, _polygon_mask
            roi = np.asarray(feedback.screenRoi)
            _polygon_mask((1, 1), roi)
            if np.any(roi.max(axis=0) - roi.min(axis=0) <= 0) or abs(np.dot(roi[:, 0], np.roll(roi[:, 1], 1)) - np.dot(roi[:, 1], np.roll(roi[:, 0], 1))) < 1e-6:
                raise HTTPException(422, "preview_feedback_screen_geometry_required")
            native_size = (roi.max(axis=0) - roi.min(axis=0)) * [body.sourceFrame.width, body.sourceFrame.height]
            if np.min(native_size) < 4:
                raise HTTPException(422, "preview_feedback_screen_geometry_required")
            for band, observed in zip(previous_patch["bands"], feedback.screenAppearanceBands):
                bound = band_raster_bound(roi, body.sourceFrame.width, body.sourceFrame.height, band["top"], band["bottom"])
                if observed.validPixels > bound:
                    raise HTTPException(422, "preview_feedback_pixel_count_exceeds_native_band")
            old_roi = previous_patch.get("compensation", {}).get("screenRoi")
            geometry_changed = old_roi is not None and (len(old_roi) != len(feedback.screenRoi)
                or np.max(np.abs(np.asarray(old_roi) - roi)) > .015)
            reset = not targets_unchanged or geometry_changed
            if not reset:
                prior_results = {r.get("id"): r for r in previous_patch.get("compensation", {}).get("perBand", [])}
                corrections = [correct_band(old["drive"], _linear(target.drive), _linear(observed.rgb), profile,
                                            prior_results.get(target.id) if prior_feedback else None)
                               for old, target, observed in zip(previous_patch["bands"], body.bands, feedback.screenAppearanceBands)]
                preview_body["bands"] = [{**band.model_dump(), "drive": result["drive"]}
                                         for band, result in zip(body.bands, corrections)]
                preview_body["compensation"] = {"status": "measuredFeedbackExperimental", "label": label,
                    "feedbackApplied": True, "observedCommandSequence": feedback.commandSequence,
                    "correctionBaseline": {key: preview_body[key] for key in
                        ("mapping", "fingerprint", "canvasColorSpace", "cameraAppearanceColorSpace", "cameraAppearanceBands")},
                    "screenRoi": feedback.screenRoi, "perBand": [{"id": band.id, **result}
                        for band, result in zip(body.bands, corrections)],
                    "warnings": ["relativeCameraAppearanceOnly", "previewNeutralWitnessNotRechecked"],
                    "physicalAccuracyVerified": False, "independentValidationStatus": "notTested"}
                preview_body["compensation"]["correctionBaseline"]["layout"] = "liveBands"
            else:
                preview_body["bands"] = feedforward_bands
                preview_body["compensation"] = feedforward_compensation
                preview_body["compensation"]["warnings"] = [*preview_body["compensation"].get("warnings", []), "previewFeedbackReset"]
                preview_body["compensation"]["feedbackApplied"] = False
        stream = s.get("previewStreamId")
        if body.streamId in s.get("retiredPreviewStreams", set()) or (stream and stream != body.streamId):
            raise HTTPException(409, "preview_stream_cycle_required")
        if not stream and len(s.get("retiredPreviewStreams", set())) >= 32:
            raise HTTPException(409, "preview_stream_cycle_limit")
        previous = s.get("previewFrame")
        frame = body.sourceFrame.model_dump()
        # Some live-camera browsers report a constant zero media clock. Preview is
        # appearance-only: increasing presentedFrames is still an actual video signal.
        zero_clock = frame["mediaTime"] == 0 and (previous is None or previous["mediaTime"] == 0)
        if previous and (frame["presentedFrames"] <= previous["presentedFrames"] or (not zero_clock and frame["mediaTime"] <= previous["mediaTime"])):
            raise HTTPException(409, "fresh_actual_preview_frame_required")
        if previous and (frame["width"], frame["height"]) != (previous["width"], previous["height"]):
            raise HTTPException(409, "preview_stream_dimensions_changed")
        now = time.monotonic()
        elapsed = now - s.get("previewIssuedAt", 0)
        if elapsed < .5:
            raise HTTPException(409, {"code": "preview_rate_limit", "retryAfterMs": max(1, int((.5 - elapsed) * 1000) + 1)})
        try:
            if zero_clock and "mediaClockUnavailable" not in preview_body["warnings"]:
                preview_body["warnings"]=(preview_body["warnings"]+["mediaClockUnavailable"])[-16:]
            patch = command(s, preview_body["bands"][0]["drive"], secrets.token_urlsafe(12), "liveBands",
                            [b.id for b in body.bands], preview=preview_body)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        s.update(previewStreamId=body.streamId, previewFrame=frame, previewIssuedAt=now)
        feedback_applied = patch.get("compensation", {}).get("feedbackApplied") is True
        evidence = {"role": "server", "stage": "feedbackAccepted" if feedback_applied else "intended",
            "commandSequence": patch["commandSequence"], "markerSequence": patch["markerSequence"],
            "presentedFrames": frame["presentedFrames"], "rawMediaTime": frame["mediaTime"],
            "nativeWidth": frame["width"], "nativeHeight": frame["height"],
            "mapping": body.mapping, "layout": "liveBands", "colorSpace": body.cameraAppearanceColorSpace,
            "targetColorSpace": body.cameraAppearanceColorSpace, "driveColorSpace": "srgb",
            "rgbEncoding": "encoded", "physicalAccuracyVerified": False, "bands": []}
        if body.feedback:
            evidence.update(observedCommandSequence=body.feedback.commandSequence,
                            observedColorSpace="srgb")
            if len(body.feedback.screenRoi) <= 8:
                evidence["screenRoi"] = body.feedback.screenRoi
        if feedback_applied:
            evidence["residualMetric"] = "linearCameraRgb"
        for index, (target, issued) in enumerate(zip(body.bands, patch["bands"])):
            band_evidence = {"bandIndex": index, "top": target.top, "bottom": target.bottom,
                             "targetRgb": target.drive, "driveRgb": issued["drive"]}
            if body.feedback:
                observed = body.feedback.screenAppearanceBands[index]
                band_evidence.update(observedRgb=observed.rgb, quality={"status": "accepted",
                    "validPixels": observed.validPixels, "validBlocks": observed.validBlocks,
                    "blockSpread": observed.blockSpread, "clippedRate": observed.clippedRate})
            if feedback_applied:
                band_evidence["residualBefore"] = patch["compensation"]["perBand"][index]["residualBefore"]
            evidence["bands"].append(band_evidence)
        server_event(s, "previewAccepted", {"evidenceSnapshot": evidence})
        await emit(s, "display.patch.set", patch)
        return patch

    def camera_match_frames(frames, *, fingerprint=None, region=None, signature=None):
        if not physical_identity(frames) or any(f.source != "videoCanvas" or f.exclusions is None for f in frames):
            raise HTTPException(422, "native_video_roi_provenance_required")
        first = frames[0]
        current = (first.regionId, first.roi, first.exclusions, first.width, first.height, first.colorSpace)
        if any((f.regionId, f.roi, f.exclusions, f.width, f.height, f.colorSpace) != current for f in frames):
            raise HTTPException(422, "native_roi_changed")
        if region and (first.regionId != region.id or first.roi != region.polygon or first.exclusions != region.exclusions):
            raise HTTPException(422, "region_provenance_mismatch")
        if signature is not None and current != signature:
            raise HTTPException(422, "native_roi_changed")
        if any(f.settingsFingerprint != (fingerprint or first.settingsFingerprint) for f in frames):
            raise HTTPException(409, "settings_fingerprint_changed")
        if max(p[0] for p in first.roi) <= min(p[0] for p in first.roi) or max(p[1] for p in first.roi) <= min(p[1] for p in first.roi):
            raise HTTPException(422, "nonempty_native_roi_required")
        return current

    @app.post("/api/sessions/{sid}/camera-matches")
    async def camera_match_start(sid: str, request: Request, body: models.CameraMatchStart):
        s = get_session(request, sid)
        active_camera_match(s)
        if s.get("previewStreamId"):
            raise HTTPException(409, "preview_must_pause_before_match")
        if s["runs"]:
            raise HTTPException(409, "match_already_active")
        signature = camera_match_frames(body.frames, region=body.region)
        if body.sourceCaptureIds != [f.id for f in body.frames] or any(f.colorSpace != body.sourceColorSpace for f in body.frames):
            raise HTTPException(422, "capture_provenance_mismatch")
        fresh(s, body.frames)
        result = await summary(body.frames)
        if result["quality"]["status"] != "accepted":
            raise HTTPException(422, "camera_match_target_quality_rejected")
        if len(s["measurements"]) >= 256:
            raise HTTPException(429, "measurement_limit")
        from .engine import BoundedMatch
        # Encoded drive is only a starting guess, never a calibrated color conversion.
        initial = [min(1., max(0., 12.92 * v if v <= .0031308 else 1.055 * v ** (1 / 2.4) - .055)) for v in result["rgb"]]
        loop = BoundedMatch(result["rgb"], initial, body.noiseFloor, body.maxEvaluations, body.target)
        try:
            patch = command(s, initial, secrets.token_urlsafe(12))
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        fresh(s, body.frames, consume=True)
        m = await build_measurement(s, body.region, result, body.sourceColorSpace, body.sourceCaptureIds, body.capturedAt, live=True, camera_match=True)
        m["sourceFrameProvenance"] = [f.model_dump(exclude={"pixels", "markerPixels", "blockIds"}) for f in body.frames]
        run_id = secrets.token_urlsafe(12)
        s["state"] = "fabric"
        s["runs"][run_id] = {"mode": "cameraMatch", "loop": loop, "measurementId": m["id"],
                               "noiseFloor": body.noiseFloor, "fingerprint": body.frames[0].settingsFingerprint,
                               "fabricSignature": signature, "screenSignature": None,
                               "commandSequence": patch["commandSequence"], "patchId": patch["patchId"]}
        await emit(s, "display.patch.set", patch)
        await emit(s, "capture.request", {"runId": run_id, **patch})
        return {"runId": run_id, "measurementId": m["id"], "nextDrive": initial, "status": "running",
                "patchId": patch["patchId"], "commandSequence": patch["commandSequence"]}

    @app.post("/api/sessions/{sid}/camera-matches/{run_id}/observe")
    async def camera_match_observe(sid: str, run_id: str, request: Request, body: models.CameraMatchObserve):
        s = get_session(request, sid)
        active_camera_match(s)
        run = s["runs"].get(run_id)
        if not run or run.get("mode") != "cameraMatch":
            raise HTTPException(409, "active_camera_match_required")
        if body.commandSequence != run["commandSequence"] or body.patchId != run["patchId"] or body.markerSequence != body.commandSequence or not body.stable:
            raise HTTPException(409, "fresh_single_stable_command_required")
        all_frames = body.frames + body.fabricFrames
        check_command(s, all_frames, body.commandSequence, body.patchId, "single", current=True)
        screen_signature = camera_match_frames(body.frames, fingerprint=run["fingerprint"], signature=run["screenSignature"])
        camera_match_frames(body.fabricFrames, fingerprint=run["fingerprint"], signature=run["fabricSignature"])
        if len(body.frames) != len(body.fabricFrames) or any(
                a.mediaTime != b.mediaTime or a.presentedFrames != b.presentedFrames
                or (a.width, a.height, a.colorSpace) != (b.width, b.height, b.colorSpace)
                or abs(a.capturedAt - b.capturedAt) > 100 for a, b in zip(body.frames, body.fabricFrames)):
            raise HTTPException(422, "co_captured_screen_fabric_required")
        fresh(s, all_frames, fingerprint=run["fingerprint"])
        result = await summary(body.frames)
        fabric = await summary(body.fabricFrames)
        if result["quality"]["status"] != "accepted" or fabric["quality"]["status"] != "accepted":
            raise HTTPException(422, "camera_match_capture_quality_rejected")
        m = next(m for m in s["measurements"] if m["id"] == run["measurementId"])
        import numpy as np
        if np.linalg.norm(np.asarray(fabric["rgb"]) - m["linearRgb"]) > run["noiseFloor"] * 3:
            from .protocol import pause
            pause(s, "fabric_target_drift")
            await emit(s, "session.state", snapshot(s))
            raise HTTPException(422, "fabric_target_drift")
        fresh(s, all_frames, consume=True)
        run["screenSignature"] = screen_signature
        output = run["loop"].observe(result["rgb"])
        del s["commands"][body.commandSequence]
        response = {"runId": run_id, "measurementId": m["id"], **output}
        if output["nextDrive"] is not None:
            patch = command(s, output["nextDrive"], secrets.token_urlsafe(12))
            run.update(commandSequence=patch["commandSequence"], patchId=patch["patchId"])
            response.update(patchId=patch["patchId"], commandSequence=patch["commandSequence"])
            await emit(s, "display.patch.set", patch)
            await emit(s, "match.iteration", response)
        else:
            m.update(displayStatus=output["status"], displayMatch=output, displayDriveRgb=output["bestDrive"])
            del s["runs"][run_id]
            s["currentPatch"] = None
            await emit(s, "match.complete", response)
        return response

    @app.post("/api/sessions/{sid}/neutral-check")
    async def neutral_check(sid: str, request: Request, body: models.NeutralCheckInput):
        s = get_session(request, sid)
        if s["paused"] or "camera" not in s["devices"]:
            raise HTTPException(409, "active_camera_required")
        if set(card.role for card in body.cards) != {"dark", "middle", "light"}:
            raise HTTPException(422, "three_distinct_neutral_cards_required")
        batches = [card.frames for card in body.cards]
        all_frames = [frame for batch in batches for frame in batch]
        if not physical_identity(all_frames):
            raise HTTPException(422, "actual_video_identity_required")
        for batch in batches:
            if any(frame.source != "videoCanvas" for frame in batch):
                raise HTTPException(422,"live_neutral_cards_required")
            first = batch[0]
            if any((frame.regionId,frame.roi,frame.exclusions,frame.width,frame.height,frame.colorSpace) != (first.regionId,first.roi,first.exclusions,first.width,first.height,first.colorSpace) for frame in batch):
                raise HTTPException(422,"neutral_card_geometry_changed")
        for batch in batches[1:]:
            if len(batch) != len(batches[0]) or any(a.mediaTime != b.mediaTime or a.presentedFrames != b.presentedFrames or (a.width,a.height,a.colorSpace) != (b.width,b.height,b.colorSpace) or abs(a.capturedAt-b.capturedAt)>100 for a,b in zip(batches[0],batch)):
                raise HTTPException(422, "co_captured_neutral_cards_required")
        fresh(s, all_frames, fingerprint=body.fingerprint)
        observed = []
        import numpy as np
        for card in body.cards:
            measured = await summary(card.frames)
            if measured["quality"]["status"] != "accepted":
                raise HTTPException(422, "neutral_card_quality_rejected")
            rgb = np.asarray(measured["rgb"])
            observed.append({"role":card.role,"linearRgb":rgb.tolist(),"relativeChannelRatios":(rgb/max(float(np.mean(rgb)),1e-9)).tolist(),"quality":measured["quality"],"sourceFrameIds":[frame.id for frame in card.frames]})
        values = {item["role"]: float(np.mean(item["linearRgb"])) for item in observed}
        if not values["dark"] < values["middle"] < values["light"]:
            raise HTTPException(422, "neutral_card_order_ambiguous")
        report = {"id":secrets.token_urlsafe(12),"status":"limitedNeutralCheck","cards":observed,"fingerprint":body.fingerprint,"referenceValuesKnown":False,"fullColorCalibration":False,"cameraControlsApplied":False,"independentValidationStatus":"notTested","limitations":["unknownCardReflectanceAndReferenceValues","threeNeutralCardsDoNotCharacterizeFullColor","noVerifiedFirmwareLock"],"nextAction":"کارت‌ها دیده و ثبات برداشت بررسی شد؛ برای تطبیق ساده، پارچه را کنار نمایشگر در قاب بگذارید."}
        fresh(s, all_frames, consume=True)
        s["neutralCheck"] = report
        import copy
        s["neutralContext"] = {"conditions": copy.deepcopy(s["conditions"]), "capabilities": copy.deepcopy(s["capabilities"]),
                               "profileVersion": s["profileVersion"]}
        await emit(s,"session.state",snapshot(s))
        return report

    @app.post("/api/sessions/{sid}/matches/{run_id}/observe")
    async def match_observe(sid: str, run_id: str, request: Request, body: models.MatchObserve):
        s = get_session(request, sid)
        run = s["runs"].get(run_id)
        if not run or s["paused"]:
            raise HTTPException(409, "active_match_required")
        if body.commandSequence != run["commandSequence"] or body.patchId != run["patchId"] or body.markerSequence != body.commandSequence or body.layout != "single" or not body.stable:
            raise HTTPException(409, "fresh_single_stable_command_required")
        check_command(s, body.frames, body.commandSequence, body.patchId, body.layout, current=True)
        if not body.cardFrames or not body.fabricFrames or not s["displayCardWitness"] or body.cardPatchId != s["displayCardWitness"]["patchId"]:
            raise HTTPException(422, "match_card_and_fabric_witness_required")
        all_frames = body.frames + body.witnessFrames + body.cardFrames + body.fabricFrames
        if not physical_identity(all_frames):
            raise HTTPException(422, "actual_video_identity_required")
        fresh(s, all_frames, fingerprint=s["cameraProfile"]["fingerprint"])
        if any(f.source != "videoCanvas" for f in body.witnessFrames):
            raise HTTPException(422, "physical_witness_required")
        result = await summary(body.frames)
        witness = await summary(body.witnessFrames)
        if result["quality"]["status"] != "accepted" or witness["quality"]["status"] != "accepted":
            raise HTTPException(422, "match_capture_quality_rejected")
        if len(body.frames) != len(body.witnessFrames) or any(abs(a.capturedAt - b.capturedAt) > 100 or (a.mediaTime is not None and b.mediaTime is not None and a.mediaTime != b.mediaTime) or (a.presentedFrames is not None and b.presentedFrames is not None and a.presentedFrames != b.presentedFrames) for a, b in zip(body.frames, body.witnessFrames)):
            raise HTTPException(422, "co_captured_witness_required")
        for paired in (body.cardFrames, body.fabricFrames):
            if len(paired) != len(body.frames) or any(a.mediaTime != b.mediaTime or a.presentedFrames != b.presentedFrames for a, b in zip(body.frames, paired)):
                raise HTTPException(422, "co_captured_card_fabric_required")
        if not await engine_call("check_witness", s["displayCardWitness"]["frames"], [f.model_dump() for f in body.cardFrames], noise_floor=run["noiseFloor"]):
            raise HTTPException(422, "unstable_match_card")
        fabric = await summary(body.fabricFrames)
        m = next(m for m in s["measurements"] if m["id"] == run["measurementId"])
        import numpy as np
        if fabric["quality"]["status"] != "accepted" or np.linalg.norm(np.asarray(fabric["rgb"]) - m["linearRgb"]) > run["noiseFloor"] * 3:
            raise HTTPException(422, "fabric_target_drift")
        if not await engine_call("check_witness", s["witnesses"], [f.model_dump() for f in body.witnessFrames], noise_floor=run["noiseFloor"]):
            from .protocol import pause
            pause(s, "unstable_witness")
            await emit(s, "session.state", snapshot(s))
            raise HTTPException(422, "unstable_witness")
        fresh(s, all_frames, consume=True)
        output = run["loop"].observe(result["rgb"])
        del s["commands"][body.commandSequence]
        response = {"runId": run_id, **output}
        if output["nextDrive"] is not None:
            patch = command(s, output["nextDrive"], secrets.token_urlsafe(12))
            run.update(commandSequence=patch["commandSequence"], patchId=patch["patchId"])
            response.update(patchId=patch["patchId"], commandSequence=patch["commandSequence"])
            await emit(s, "display.patch.set", patch)
            await emit(s, "match.iteration", response)
        else:
            m = next(m for m in s["measurements"] if m["id"] == run["measurementId"])
            m.update(displayStatus=output["status"], displayMatch=output, displayDriveRgb=output["bestDrive"])
            del s["runs"][run_id]
            s["currentPatch"] = None
            await emit(s, "match.complete", response)
        return response

    def fresh(s, frames, *, consume=False, fingerprint=None):
        ids = [f.id for f in frames]
        if len(ids) != len(set(ids)) or any(i in s["usedFrames"] for i in ids):
            raise HTTPException(409, "duplicate_or_reused_capture")
        if fingerprint and any(f.settingsFingerprint != fingerprint for f in frames):
            raise HTTPException(409, "settings_fingerprint_changed")
        video_ids = [(f.settingsFingerprint, f.presentedFrames, f.mediaTime, f.width, f.height,
                      (min(p[0] for p in f.roi), min(p[1] for p in f.roi), max(p[0] for p in f.roi), max(p[1] for p in f.roi)) if f.roi else None) for f in frames
                     if f.presentedFrames is not None and f.mediaTime is not None]
        checked = list(s["usedVideoFrames"])
        for identity in video_ids:
            for previous in checked:
                if identity[:3] == previous[:3]:
                    a, b = identity[-1], previous[-1]
                    if identity[3:5] != previous[3:5] or a is None or b is None or not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1]):
                        raise HTTPException(409, "reused_or_overlapping_video_frame")
            checked.append(identity)
        if consume:
            if len(s["usedFrames"]) + len(ids) > 10000:
                raise HTTPException(429, "capture_limit")
            s["usedFrames"].update(ids)
            s["usedVideoFrames"].update(video_ids)

    async def summary(frames):
        return await engine_call("summarize_frames", [f.model_dump() for f in frames])

    def physical_identity(frames):
        return all(f.presentedFrames is not None and f.mediaTime is not None and f.width is not None and f.height is not None and f.roi is not None and f.regionId is not None for f in frames)

    async def build_measurement(s, region, result, source, capture_ids, captured_at, *, live=False, witnessed=False, camera_match=False):
        camera_match = camera_match or s["mode"] == "cameraMatch"
        if len(s["measurements"]) >= 256:
            raise HTTPException(429, "measurement_limit")
        camera = s["cameraProfile"]
        referenced = bool(camera and camera.get("matrix") is not None and camera.get("status") != "exploratory" and witnessed)
        accepted = result["quality"]["status"] == "accepted"
        catalog = None
        if accepted and not camera_match:
            if referenced and live:
                try:
                    xyz = await engine_call("apply_camera", result["rgb"], camera)
                except HTTPException as exc:
                    if exc.status_code != 422:
                        raise
                    accepted = False
                    result["quality"]["status"] = "rejected"
                    result["quality"].setdefault("warnings", []).append(str(exc.detail))
                    xyz = None
            else:
                # Engine summary is already linear canonical sRGB; avoid decoding twice.
                import numpy as np
                from .engine import MATRICES
                xyz = np.asarray(result["rgb"]) @ MATRICES["srgb"].T
            if xyz is not None:
                catalog = await engine_call("catalog_color", xyz)
        m = dict(id=secrets.token_urlsafe(12), region=region.model_dump(), captureQuality=result["quality"]["status"],
                 quality=result["quality"], linearRgb=result["rgb"], sourceColorSpace=source,
                 sourceCaptureIds=capture_ids, capturedAt=captured_at, profileVersion=s["profileVersion"],
                 catalogStatus="rejected" if not accepted else "referenced" if referenced and live else "exploratory",
                 displayStatus="notMatched", catalogColor=catalog,
                 catalogHexSrgb=catalog.get("hex") if catalog else None, approved=False,
                 provenance="referencedLive" if referenced and live else "approximateReplay" if not live else "exploratoryLive",
                 instrumentDeltaE00=None, displayDriveRgb=None, physicalControlStatus="unverified",
                 approvalLimitations=["independentInstrumentValidationNotTested", "cameraLocksUnverified"],
                 sourceFrameProvenance=[], independentValidationStatus="notTested")
        m["captureConditions"] = {"geometry": s["conditions"].get("geometry"), "background": region.background, "layers": region.layers}
        if camera_match:
            m["approvalLimitations"] += ["noVerifiedPhysicalReference", "noNeutralWitness", "displayContaminationNotIndependentlyTested", "cameraRgbObjectiveNotDeltaE", "notForCatalogOrSite"]
        elif live and not witnessed:
            m["approvalLimitations"].append("freshPhysicalWitnessesMissing")
        s["measurements"].append(m)
        await emit(s, "measurement.submit", m)
        return m

    @app.post("/api/sessions/{sid}/captures/analyze")
    async def analyze(sid: str, request: Request, body: models.Analyze):
        s = get_session(request, sid)
        fresh(s, body.frames)
        result = await summary(body.frames)
        await emit(s, "quality.alert", result["quality"])
        return result

    @app.post("/api/sessions/{sid}/measurements")
    async def measurement(sid: str, request: Request, body: models.MeasurementInput):
        s = get_session(request, sid)
        if s["state"] != "fabric" or not s["cameraProfile"]:
            raise HTTPException(409, "fabric_stage_required")
        if any(f.source == "videoCanvas" for f in body.frames) and (s["paused"] or "camera" not in s["devices"]):
            raise HTTPException(409, "active_camera_required")
        if body.sourceCaptureIds != [f.id for f in body.frames] or any(f.colorSpace != body.sourceColorSpace for f in body.frames):
            raise HTTPException(422, "capture_provenance_mismatch")
        fresh(s, body.frames, fingerprint=s["cameraProfile"]["fingerprint"])
        result = await summary(body.frames)
        all_frames = list(body.frames)
        live = s["mode"] != "replay" and all(f.source == "videoCanvas" for f in body.frames)
        witnessed = False
        if live and body.cardFrames and body.witnessFrames:
            all_frames += body.cardFrames + body.witnessFrames
            fresh(s, all_frames, fingerprint=s["cameraProfile"]["fingerprint"])
            paired = all(len(other) == len(body.frames) and all(a.mediaTime == b.mediaTime and a.presentedFrames == b.presentedFrames for a, b in zip(body.frames, other)) for other in (body.cardFrames, body.witnessFrames))
            card_base = s["cameraWitnesses"].get(body.cardPatchId)
            if physical_identity(all_frames) and paired and card_base:
                stable_card = await engine_call("check_witness", card_base, [f.model_dump() for f in body.cardFrames])
                neutral_base = s["witnesses"] or card_base
                stable_neutral = await engine_call("check_witness", neutral_base, [f.model_dump() for f in body.witnessFrames])
                witnessed = stable_card and stable_neutral
        fresh(s, all_frames, consume=True)
        m = await build_measurement(s, body.region, result, body.sourceColorSpace, body.sourceCaptureIds, body.capturedAt, live=live, witnessed=witnessed)
        m["sourceFrameProvenance"] = [f.model_dump(exclude={"pixels", "markerPixels", "blockIds"}) for f in body.frames]
        if live:
            # Browser capability reports cannot prove firmware locks or physical accuracy.
            m["approved"] = False
        return m

    @app.post("/api/sessions/{sid}/images")
    async def upload(sid: str, request: Request, file: UploadFile = File(), retention: str = Form("false")):
        s = get_session(request, sid)
        form = await request.form()
        if set(form.keys()) - {"file", "retention"} or len(form.getlist("file")) != 1 or len(form.getlist("retention")) > 1:
            raise HTTPException(422, "unknown_or_duplicate_upload_fields")
        if retention not in ("true", "false"):
            raise HTTPException(422, "retention_must_be_boolean")
        if len(s["images"]) >= 4:
            raise HTTPException(429, "image_limit")
        data = await file.read(12 * 1024 * 1024 + 1)
        await file.close()
        if len(data) > 12 * 1024 * 1024:
            raise HTTPException(413, "image_too_large")
        # Header preflight bounds decode allocations, before handing bytes to ICC engine.
        import io
        import numpy as np
        from PIL import Image
        try:
            with Image.open(io.BytesIO(data)) as source:
                width, height = source.size
                if width * height > 8000000 or max(width, height) > 12000:
                    raise HTTPException(413, "image_dimensions_too_large")
                if source.format not in ("PNG", "JPEG", "WEBP"):
                    raise HTTPException(422, "unsupported_image_format")
        except (OSError, Image.DecompressionBombError) as exc:
            raise HTTPException(422, "invalid_encoded_image") from exc
        decoded = await engine_call("decode_image", data, assumed_space="srgb")
        decoded["metadata"]["sha256"] = hashlib.sha256(data).hexdigest()
        if sum(item["rgb"].nbytes for item in s["images"].values()) + decoded["rgb"].nbytes > 64 * 1024 * 1024:
            raise HTTPException(413, "session_image_memory_limit")
        capture_id = secrets.token_urlsafe(18)
        preview = Image.fromarray(np.floor(np.clip(decoded["rgb"], 0, 1) * 255 + .5).astype("uint8"))
        stream = io.BytesIO()
        from PIL import ImageCms
        srgb_icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        preview.save(stream, format="PNG", icc_profile=srgb_icc)
        s["images"][capture_id] = dict(rgb=decoded["rgb"], metadata=decoded["metadata"], preview=stream.getvalue(),
                                         original=data if retention == "true" else None)
        return {"captureId": capture_id, "width": width, "height": height,
                "sourceColorSpace": decoded["metadata"].get("sourceColorSpace", "assumed-srgb"),
                "colorProvenance": decoded["metadata"],
                "previewUrl": f"/api/sessions/{sid}/images/{capture_id}/preview"}

    @app.post("/api/sessions/{sid}/measurements/{mid}/override")
    async def override(sid: str, mid: str, request: Request, body: models.OverrideInput):
        s = get_session(request, sid)
        if s["mode"] == "cameraMatch":
            raise HTTPException(409, "camera_match_catalog_output_forbidden")
        original = next((m for m in s["measurements"] if m["id"] == mid), None)
        if not original:
            raise HTTPException(404, "measurement_not_found")
        if len(s["measurements"]) >= 256:
            raise HTTPException(429, "measurement_limit")
        import copy
        m = copy.deepcopy(original)
        m.update(id=secrets.token_urlsafe(12), version=original.get("version", 1) + 1,
                 sourceMeasurementId=mid, manualOverride=True, overrideReason=body.reason,
                 originalEstimate=original.get("originalEstimate", original["catalogColor"]),
                 catalogColor=None, catalogHexSrgb=body.catalogHexSrgb.upper(), catalogStatus="manualOverride",
                 approved=False, displayDriveRgb=None, displayStatus="notMatched")
        m.pop("displayMatch", None)
        s["measurements"].append(m)
        await emit(s, "measurement.submit", m)
        return m

    def get_image(s, cid):
        image = s["images"].get(cid)
        if image is None:
            raise HTTPException(404, "capture_not_found")
        return image

    @app.get("/api/sessions/{sid}/images/{cid}/preview")
    def preview(sid: str, cid: str, request: Request):
        image = get_image(get_session(request, sid), cid)
        return Response(image["preview"], media_type="image/png", headers={"Cache-Control": "no-store"})

    @app.post("/api/sessions/{sid}/images/{cid}/regions")
    async def image_regions(sid: str, cid: str, request: Request, body: models.RegionsInput):
        s = get_session(request, sid)
        image = get_image(s, cid)
        if len(s["measurements"]) + len(body.regions) > 256:
            raise HTTPException(429, "measurement_limit")
        measurements = []
        for region in body.regions:
            result = await engine_call("extract_region", image["rgb"], region.model_dump())
            measurements.append(await build_measurement(s, region, result, image["metadata"].get("sourceColorSpace", "srgb"), [cid], datetime.now(timezone.utc).isoformat()))
        return {"measurements": measurements}

    @app.post("/api/sessions/{sid}/images/{cid}/suggest-bands")
    async def bands(sid: str, cid: str, request: Request, body: models.SuggestInput):
        image = get_image(get_session(request, sid), cid)
        result = await engine_call("suggest_bands", image["rgb"], body.polygon, body.orientation)
        return {"regions": result}

    @app.post("/api/sessions/{sid}/validations")
    async def validation(sid: str, request: Request, body: models.RepeatabilityInput | models.ReacquisitionInput | models.InstrumentInput):
        s = get_session(request, sid)
        if len(s["validationReports"]) >= 64:
            raise HTTPException(429, "validation_report_limit")
        from . import validation as module
        try:
            if isinstance(body, models.RepeatabilityInput):
                report = module.repeatability_report([sample.model_dump() for sample in body.samples], white=body.referenceWhite, observer=body.observer)
            elif isinstance(body, models.ReacquisitionInput):
                report = module.reacquisition_report(body.original, body.observed, capture_id=body.captureId, white=body.referenceWhite, observer=body.observer)
            else:
                m = next((m for m in s["measurements"] if m["id"] == body.measurementId), None)
                if (not m or not m["catalogColor"] or body.estimate.get("lab") != m["catalogColor"]["lab"]
                        or body.estimate.get("measurementId") != m["id"] or body.estimate.get("measurementVersion") != m.get("version", 1)
                        or body.estimate.get("referenceWhite") != m["catalogColor"]["referenceWhite"] or body.estimate.get("observer") != "2"):
                    raise ValueError("estimate_must_match_server_measurement")
                if any(m["captureConditions"].get(field) is None or body.estimate.get(field) != m["captureConditions"][field] for field in ("geometry", "background", "layers")):
                    raise ValueError("instrument_conditions_must_match_recorded_capture")
                report = module.instrument_report(body.estimate, body.reading)
                report["measurementId"] = body.measurementId
        except (ValueError, TypeError, KeyError) as exc:
            raise HTTPException(422, str(exc)) from exc
        report["id"] = secrets.token_urlsafe(12)
        s["validationReports"].append(report)
        return report

    @app.get("/api/sessions/{sid}/export")
    async def export(sid: str, request: Request, format: str = "json", kind: str = "experimental"):
        s = get_session(request, sid)
        if format not in ("json", "csv") or kind not in ("experimental", "approved"):
            raise HTTPException(422, "invalid_export_options")
        report = {"version": 1, "kind": kind, "exportKind": kind, "storage": "ephemeral",
                  "independentValidationStatus": "notTested", "validationReports": s["validationReports"], **snapshot(s)}
        if s["mode"] == "cameraMatch":
            report["status"] = "exploratoryCameraMatch"
        report["measurements"] = [dict(m) for m in s["measurements"]]
        if kind == "approved":
            for measurement in report["measurements"]:
                if not measurement.get("approved", False):
                    measurement["catalogColor"] = None
                    measurement["catalogHexSrgb"] = None
        await emit(s, "export.request", {"format": format, "kind": kind})
        if format == "json":
            return report
        import csv
        import io
        stream = io.StringIO()
        writer = csv.writer(stream)
        writer.writerow(["measurementId", "region", "captureQuality", "catalogStatus", "displayStatus", "approved", "catalogHexSrgb", "displayDriveRgb", "instrumentDeltaE00", "independentValidationStatus", "catalogColor", "failureReport"])
        for m in report["measurements"]:
            row = [m["id"], m["region"]["label"], m["quality"]["status"], m["catalogStatus"],
                   m["displayStatus"], m["approved"], m.get("catalogHexSrgb"), json.dumps(m.get("displayDriveRgb")), m.get("instrumentDeltaE00"),
                   m["independentValidationStatus"], json.dumps(m["catalogColor"]), json.dumps(m["quality"])]
            writer.writerow(["'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@", "\t", "\r")) else v for v in row])
        return Response(stream.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=colorlab.csv"})

    from .protocol import install
    install(app)
    dist = Path(static_dir) if static_dir else Path(__file__).resolve().parent.parent / "frontend" / "dist"
    if dist.is_dir():
        @app.get("/display")
        def display_page():
            return FileResponse(dist / "index.html", headers={"Cache-Control": "no-store"})
        app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
    return app


app = create_app()
