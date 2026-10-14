"""Private software-event files; never store request bodies, headers or images."""
import hashlib
import json
import os
import threading
from pathlib import Path


class DiagnosticsStore:
    def __init__(self, directory, *, file_limit=1024 * 1024, total_limit=32 * 1024 * 1024):
        self.directory = Path(directory)
        self.file_limit = file_limit
        self.total_limit = total_limit
        self.lock = threading.RLock()

    def path(self, diagnostic_id):
        return self.directory / (hashlib.sha256(diagnostic_id.encode()).hexdigest() + ".jsonl")

    def append(self, diagnostic_id, events):
        data = b"".join((json.dumps({"schemaVersion": 1, "diagnosticId": diagnostic_id, **event}, separators=(",", ":"), allow_nan=False) + "\n").encode() for event in events)
        with self.lock:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.directory.chmod(0o700)
            path = self.path(diagnostic_id)
            if path.exists() and path.stat().st_size + len(data) > self.file_limit:
                with path.open("rb") as stream:
                    stream.seek(max(0, path.stat().st_size - self.file_limit))
                    data = stream.read(self.file_limit) + data
                data = data[-self.file_limit:]
                data = data[data.find(b"\n") + 1:]
                flags = os.O_TRUNC
            else:
                flags = os.O_APPEND
            if len(data) > self.file_limit:
                data = data[-self.file_limit:]
                data = data[data.find(b"\n") + 1:]
            fd = os.open(path, os.O_WRONLY | flags | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "ab") as stream:
                stream.write(data)
            path.chmod(0o600)
            files = sorted(self.directory.glob("*.jsonl"), key=lambda item: item.stat().st_mtime_ns)
            total = sum(item.stat().st_size for item in files)
            for item in files:
                if total <= self.total_limit:
                    break
                if item != path:
                    total -= item.stat().st_size
                    item.unlink()
            return path.stat().st_size

    def delete(self, diagnostic_id):
        with self.lock:
            self.path(diagnostic_id).unlink(missing_ok=True)

    def size(self, diagnostic_id):
        path = self.path(diagnostic_id)
        return path.stat().st_size if path.is_file() else 0
