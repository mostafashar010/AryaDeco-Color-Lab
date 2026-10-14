"""Single-process LAN lab with reusable local HTTPS and an explicit local mode."""

import argparse
import ipaddress
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlsplit


def parse_options(argv=None):
    parser = argparse.ArgumentParser(description="AryaDeco Color Lab local server")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--origin")
    parser.add_argument("--cert", type=Path)
    parser.add_argument("--key", type=Path)
    parser.add_argument("--local", action="store_true", help="Loopback HTTP development only")
    parser.add_argument("--config", type=Path, help="Saved JSON server settings")
    parser.add_argument("--lan-ip", help="Explicit private LAN IPv4 if detection is ambiguous")
    options = parser.parse_args(argv)
    if options.config:
        try:
            if options.config.stat().st_size > 16384:
                raise ValueError("server config is too large")
            saved = json.loads(options.config.read_text())
            if not isinstance(saved, dict) or saved.get("version") != 1 or set(saved) - {"version", "host", "port", "origin", "cert", "key"}:
                raise ValueError("unknown server config fields or version")
            for field in ("host", "origin", "cert", "key"):
                if field in saved and (not isinstance(saved[field], str) or not saved[field]):
                    raise ValueError(f"invalid {field}")
            if "port" in saved and type(saved["port"]) is not int:
                raise ValueError("invalid port")
            for field in ("host", "port", "origin", "cert", "key"):
                if getattr(options, field) is None and field in saved:
                    value = saved[field]
                    if field in ("cert", "key"):
                        value = options.config.resolve().parent / value
                    setattr(options, field, value)
        except (OSError, ValueError, TypeError) as exc:
            parser.error(f"invalid server config: {exc}")
    if options.local:
        if options.host or options.origin or options.cert or options.key or options.lan_ip or options.config:
            parser.error("--local cannot be combined with network settings")
        options.host = "127.0.0.1"
    options.host = options.host or "0.0.0.0"
    options.port = options.port if options.port is not None else 8443
    options.auto_tls = False
    local = options.host in ("127.0.0.1", "::1", "localhost")
    if not 1 <= options.port <= 65535:
        parser.error("port must be between 1 and 65535")
    tls = options.cert is not None or options.key is not None
    if tls and (not options.cert or not options.key or not options.cert.is_file() or not options.key.is_file()):
        parser.error("both an existing certificate and private key are required")
    if not local and not tls and not options.origin:
        options.auto_tls = True
        if options.lan_ip:
            try:
                choose_lan_address([{"dev": "explicit", "prefsrc": options.lan_ip}])
            except ValueError as exc:
                parser.error(str(exc))
        return options
    if not local and (not tls or not options.origin):
        parser.error("network access requires --cert, --key and explicit HTTPS --origin")
    options.origin = options.origin or f"{'https' if tls else 'http'}://localhost:{options.port}"
    if any(ord(character) <= 32 for character in options.origin):
        parser.error("origin cannot contain whitespace or control characters")
    try:
        parts = urlsplit(options.origin)
        origin_port = parts.port
        if origin_port == 0:
            parser.error("origin port must be 1..65535")
    except ValueError:
        parser.error("origin host or port is invalid")
    if parts.scheme not in ("http", "https") or not parts.hostname or "@" in parts.netloc or parts.netloc.endswith(":") or parts.path or parts.query or parts.fragment:
        parser.error("origin must be an exact http(s) scheme://host[:port], without credentials or path")
    if tls and parts.scheme != "https":
        parser.error("TLS requires an HTTPS origin")
    if not tls and (parts.scheme != "http" or parts.hostname not in ("localhost", "127.0.0.1", "::1")):
        parser.error("plain HTTP is permitted only for local development")
    hostname = parts.hostname.lower().encode("idna").decode("ascii")
    if ":" in hostname:
        hostname = f"[{hostname}]"
    port_suffix = "" if origin_port is None or origin_port == (443 if tls else 80) else f":{origin_port}"
    options.origin = f"{parts.scheme}://{hostname}{port_suffix}"
    return options


def choose_lan_address(routes, interfaces=None):
    candidates = []
    for route in routes:
        device = route.get("dev", "")
        if device.startswith(("lo", "docker", "br-", "veth", "tun", "tap", "tailscale", "outline", "wg")) or "tun" in device:
            continue
        source = route.get("prefsrc")
        if not source and interfaces:
            source = next((item["local"] for interface in interfaces if interface.get("ifname") == device for item in interface.get("addr_info", []) if item.get("family") == "inet" and item.get("scope") == "global"), "")
        try:
            address = ipaddress.IPv4Address(source or "")
        except ipaddress.AddressValueError:
            continue
        private = any(address in ipaddress.IPv4Network(network) for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
        if private:
            candidates.append((int(route.get("metric", 0)), str(address)))
    if not candidates:
        raise ValueError("Private LAN address not found; use --lan-ip with the laptop's Wi-Fi/Ethernet IP")
    return min(candidates)[1]


def prepare_lan_https(directory, address):
    """Generate certificate material, not application source; never install system trust."""
    address = choose_lan_address([{"dev": "explicit", "prefsrc": address}])
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    ca, ca_key = directory / "phone-root-ca.crt", directory / "phone-root-ca.key"
    cert, key = directory / "lab.pem", directory / "lab-key.pem"
    if ca.exists() != ca_key.exists():
        raise ValueError("Incomplete local CA; do not overwrite keys automatically")
    def openssl(*args, input=None):
        previous_umask = os.umask(0o077)
        try:
            return subprocess.run(["openssl", *map(str, args)], input=input, text=True, capture_output=True, check=True)
        finally:
            os.umask(previous_umask)
    if not ca.exists():
        openssl("req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "3650", "-keyout", ca_key, "-out", ca, "-subj", "/CN=AryaDeco Color Lab Local Phone CA", "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    ca_key.chmod(0o600)
    ca.chmod(0o644)
    stamp = directory / "address.json"
    reusable = False
    if cert.is_file() and key.is_file() and stamp.is_file():
        try:
            reusable = json.loads(stamp.read_text()).get("address") == address and openssl("x509", "-in", cert, "-checkend", "86400", "-noout").returncode == 0
            if reusable:
                openssl("verify", "-CAfile", ca, "-verify_ip", address, cert)
        except (OSError, ValueError, subprocess.CalledProcessError):
            reusable = False
    if not reusable:
        csr = directory / "lab.csr"
        openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=AryaDeco Color Lab Laptop")
        key.chmod(0o600)
        extensions = f"basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:{address},IP:127.0.0.1,DNS:localhost\n"
        openssl("x509", "-req", "-in", csr, "-CA", ca, "-CAkey", ca_key, "-set_serial", f"0x{os.urandom(16).hex()}", "-days", "365", "-sha256", "-out", cert, "-extfile", "/dev/stdin", input=extensions)
        csr.unlink(missing_ok=True)
        stamp.write_text(json.dumps({"address": address, "version": 1}) + "\n")
    key.chmod(0o600)
    openssl("verify", "-CAfile", ca, "-verify_ip", address, cert)
    return cert, key, ca


def lan_origin(address, port):
    return f"https://{address}" + ("" if port == 443 else f":{port}")


if __name__ == "__main__":
    options = parse_options()
    root = Path(__file__).resolve().parent
    if not (root / "frontend/dist/index.html").is_file():
        raise SystemExit("Build the frontend first: npm --prefix frontend ci && npm --prefix frontend run build")
    if options.auto_tls:
        try:
            if options.lan_ip:
                address = options.lan_ip
            else:
                routes = json.loads(subprocess.run(["ip", "-j", "-4", "route", "show", "default"], capture_output=True, text=True, check=True).stdout)
                interfaces = json.loads(subprocess.run(["ip", "-j", "-4", "address", "show"], capture_output=True, text=True, check=True).stdout)
                address = choose_lan_address(routes, interfaces)
            options.cert, options.key, ca = prepare_lan_https(root / "certs", address)
        except (ValueError, OSError, subprocess.CalledProcessError) as exc:
            raise SystemExit(f"Local HTTPS setup failed: {exc}") from exc
        options.origin = lan_origin(address, options.port)
        os.environ["COLORLAB_PHONE_CA"] = str(ca)
        fingerprint = subprocess.run(["openssl", "x509", "-in", str(ca), "-noout", "-fingerprint", "-sha256"], capture_output=True, text=True, check=True).stdout.strip()
        print(f"\nPhone A + B and laptop: {options.origin}\nOne-time phone trust: {options.origin}/phone-setup\nPublic CA file: {ca}\n{fingerprint}\nPrivate CA key stays on this laptop; do not share it.\n", flush=True)
    else:
        print(f"\nOpen this exact address: {options.origin}\n", flush=True)
    os.environ["COLORLAB_ORIGIN"] = options.origin
    import uvicorn

    uvicorn.run(
        "colorlab.app:app", host=options.host, port=options.port, workers=1,
        ssl_certfile=str(options.cert) if options.cert else None,
        ssl_keyfile=str(options.key) if options.key else None,
        access_log=False, ws_max_size=262144, ws_max_queue=8,
        timeout_keep_alive=10,
    )
