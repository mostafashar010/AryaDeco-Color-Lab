"""Explicitly consented, short-lived diagnostic previews, never measurement input."""
import copy
import io
import math
import os
import re
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError


class LiveDebugStore:
    ttl = 300
    max_frames = 8
    capture_interval_ms = 3000
    max_upload_bytes = 300 * 1024
    max_edge = 640
    max_pixels = 640 * 640

    def __init__(self, directory, *, clock=time.time, total_limit=10 * 1024 * 1024):
        self.directory = Path(directory)
        self.clock = clock
        self.total_limit = total_limit
        self.sessions = {}
        self.lock = threading.RLock()
        self.sweep()

    def start(self, sid, debug_id, session_expiry):
        if not re.fullmatch(r"test-[a-f0-9]{24}", debug_id):
            raise ValueError("invalid_debug_id")
        with self.lock:
            self.sweep()
            if sid not in self.sessions:
                self.sessions[sid] = {"debugId": debug_id, "expiry": min(self.clock() + self.ttl, session_expiry),
                                      "frames": [], "sequence": 0}
            return self.status(sid, debug_id)

    def stop(self, sid):
        with self.lock:
            state = self.sessions.pop(sid, None)
            if state:
                self._purge_directory(self.directory / state["debugId"])

    def _purge_directory(self, directory):
        if self.directory.is_symlink():
            return
        if directory.is_symlink():
            directory.unlink()
        elif directory.is_dir():
            shutil.rmtree(directory)

    def sweep(self):
        with self.lock:
            for sid, state in list(self.sessions.items()):
                if self.clock() >= state["expiry"]:
                    self.stop(sid)
            if self.directory.is_dir() and not self.directory.is_symlink():
                active = {state["debugId"] for state in self.sessions.values()}
                for directory in self.directory.iterdir():
                    if re.fullmatch(r"test-[a-f0-9]{24}", directory.name) and directory.name not in active:
                        self._purge_directory(directory)

    def status(self, sid, debug_id):
        with self.lock:
            self.sweep()
            state = self.sessions.get(sid)
            latest = None
            if state and state["frames"]:
                latest = {key: copy.deepcopy(value) for key, value in state["frames"][-1].items() if key not in ("path", "size")}
                latest["previewUrl"] = f"/api/sessions/{sid}/live-debug/frames/latest"
            return {"enabled": state is not None, "debugId": debug_id,
                    "expiresAt": datetime.fromtimestamp(state["expiry"], timezone.utc).isoformat() if state else None,
                    "maxFrames": self.max_frames, "captureIntervalMs": self.capture_interval_ms,
                    "frameCount": len(state["frames"]) if state else 0, "latest": latest}

    def append(self, sid, data, metadata, content_type):
        with self.lock:
            self.sweep()
            state = self.sessions.get(sid)
            if state is None:
                raise HTTPException(409, "live_debug_disabled")
            now = self.clock()
            if "lastFrameAt" in state and now - state["lastFrameAt"] < self.capture_interval_ms / 1000:
                retry = math.ceil(self.capture_interval_ms / 1000 - (now - state["lastFrameAt"]))
                raise HTTPException(429, "live_debug_capture_rate_limit", headers={"Retry-After": str(max(1, retry))})
            for field in ("presentedFrames", "mediaTime"):
                if field in metadata and field in state and metadata[field] <= state[field]:
                    if(field=="mediaTime" and metadata[field]==0 and state[field]==0
                       and metadata.get("presentedFrames",-1)>state.get("presentedFrames",-1)):
                        continue
                    raise HTTPException(409, "live_debug_stale_frame")
            if len(data) > self.max_upload_bytes:
                raise HTTPException(413, "live_debug_image_too_large")
            if content_type not in ("image/jpeg", "image/png"):
                raise HTTPException(415, "live_debug_jpeg_or_png_required")
            try:
                with Image.open(io.BytesIO(data)) as source:
                    if source.format not in ("JPEG", "PNG"):
                        raise HTTPException(415, "live_debug_jpeg_or_png_required")
                    if max(source.size) > self.max_edge or source.width * source.height > self.max_pixels:
                        raise HTTPException(413, "live_debug_image_dimensions")
                    if getattr(source, "n_frames", 1) != 1:
                        raise HTTPException(422, "live_debug_single_frame_required")
                    source.verify()
                with Image.open(io.BytesIO(data)) as source:
                    source.load()
                    canonical = Image.new("RGB", source.size)
                    canonical.paste(source.convert("RGB"))
                output = io.BytesIO()
                canonical.save(output, format="PNG")
            except Image.DecompressionBombError as exc:
                raise HTTPException(413, "live_debug_image_dimensions") from exc
            except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
                raise HTTPException(422, "live_debug_invalid_image") from exc
            encoded = output.getvalue()
            oldest = state["frames"][0] if len(state["frames"]) == self.max_frames else None
            total = sum(frame["size"] for session in self.sessions.values() for frame in session["frames"])
            if total + len(encoded) - (oldest["size"] if oldest else 0) > self.total_limit:
                raise HTTPException(429, "live_debug_storage_limit")
            directory = self.directory / state["debugId"]
            if self.directory.is_symlink() or directory.is_symlink():
                raise OSError("unsafe_live_debug_directory")
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.directory.chmod(0o700)
            directory.mkdir(mode=0o700, exist_ok=True)
            directory.chmod(0o700)
            if oldest:
                oldest["path"].unlink(missing_ok=True)
                state["frames"].pop(0)
            sequence = state["sequence"] + 1
            path = directory / f"{sequence:06d}.png"
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(encoded)
            except OSError:
                path.unlink(missing_ok=True)
                raise
            state["sequence"] = sequence
            state["lastFrameAt"] = now
            state.update({field: metadata[field] for field in ("presentedFrames", "mediaTime") if field in metadata})
            state["frames"].append({"path": path, "size": len(encoded), "sequence": sequence,
                                    "capturedAt": datetime.fromtimestamp(now, timezone.utc).isoformat(),
                                    "width": canonical.width, "height": canonical.height,
                                    "metadata": copy.deepcopy(metadata),
                                    "colorProvenance": "assumedSrgbDiagnosticPreviewNotRawNotMeasurement"})
            return self.status(sid, state["debugId"])

    def latest(self, sid):
        with self.lock:
            self.sweep()
            state = self.sessions.get(sid)
            if not state or not state["frames"]:
                raise HTTPException(404, "live_debug_frame_not_found")
            path = state["frames"][-1]["path"]
            if self.directory.is_symlink() or path.parent.is_symlink():
                raise OSError("unsafe_live_debug_directory")
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "rb") as stream:
                return stream.read(state["frames"][-1]["size"])
