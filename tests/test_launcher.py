import importlib.util
from pathlib import Path

import pytest


def launcher():
    path = Path(__file__).parents[1] / "run.py"
    if not path.exists():
        pytest.fail("A runnable, safe launcher has not been implemented")
    spec = importlib.util.spec_from_file_location("colorlab_launcher", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_default_launch_uses_auto_https_lan():
    options = launcher().parse_options([])
    assert options.host == "0.0.0.0"
    assert options.port == 8443
    assert options.auto_tls is True


def test_local_flag_preserves_explicit_loopback_development():
    options = launcher().parse_options(["--local"])
    assert options.host == "127.0.0.1"
    assert options.origin == "http://localhost:8443"


def test_all_interface_network_listening_prepares_tls_automatically():
    options = launcher().parse_options(["--host", "0.0.0.0"])
    assert options.host == "0.0.0.0"
    assert options.auto_tls is True


def test_certificate_and_key_must_both_exist(tmp_path):
    with pytest.raises(SystemExit):
        launcher().parse_options(["--cert", str(tmp_path / "missing.pem")])


def test_network_origin_must_be_https_and_explicit(tmp_path):
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    cert.touch()
    key.touch()
    with pytest.raises(SystemExit):
        launcher().parse_options([
            "--host", "192.168.1.23", "--cert", str(cert), "--key", str(key)
        ])
    options = launcher().parse_options([
        "--host", "192.168.1.23", "--cert", str(cert), "--key", str(key),
        "--origin", "https://192.168.1.23:8443"
    ])
    assert options.origin == "https://192.168.1.23:8443"


@pytest.mark.parametrize("origin", ["https://host/path", "https://host?token=a", "https://user:secret@host", "*", "http://localhost:999999", "http://localhost:notaport", "http://localhost\n:8443", "http://[invalid"])
def test_origin_is_not_a_wildcard_or_credential_bearing_url(origin):
    with pytest.raises(SystemExit):
        launcher().parse_options(["--origin", origin])


def test_origin_is_normalized_like_browser_serialization(tmp_path):
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    cert.touch()
    key.touch()
    options = launcher().parse_options(["--cert", str(cert), "--key", str(key), "--origin", "https://LOCALHOST:443"])
    assert options.origin == "https://localhost"


@pytest.mark.parametrize("origin", ["http://@localhost:8443", "http://localhost:"])
def test_empty_userinfo_or_empty_port_is_rejected(origin):
    with pytest.raises(SystemExit):
        launcher().parse_options(["--origin", origin])


def test_saved_lan_options_load_relative_paths_from_config_not_cwd(tmp_path):
    import json
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    cert.touch()
    key.touch()
    config = tmp_path / "server.json"
    config.write_text(json.dumps({"version": 1, "host": "0.0.0.0", "port": 8443, "origin": "https://192.168.8.8:8443", "cert": "cert.pem", "key": "key.pem"}))
    options = launcher().parse_options(["--config", str(config)])
    assert options.host == "0.0.0.0"
    assert options.cert == cert
    assert options.key == key
    assert options.origin == "https://192.168.8.8:8443"


def test_saved_config_never_weakens_https_or_reads_arbitrary_fields(tmp_path):
    import json
    config = tmp_path / "server.json"
    for content in ({"version": 1, "host": "0.0.0.0", "origin": "http://192.168.8.8:8443"}, {"version": 1, "token": "never"}, {"version": 7}, {"version": 1, "port": True}):
        config.write_text(json.dumps(content))
        with pytest.raises(SystemExit):
            launcher().parse_options(["--config", str(config)])


def test_choose_lan_address_uses_physical_private_default_route_not_vpn():
    module = launcher()
    routes = [{"dev": "tailscale0", "prefsrc": "100.101.154.28", "metric": 1}, {"dev": "wlp0s20f3", "prefsrc": "192.168.8.8", "metric": 600}]
    assert module.choose_lan_address(routes) == "192.168.8.8"
    with pytest.raises(ValueError):
        module.choose_lan_address([{"dev": "singbox_tun", "prefsrc": "172.18.0.1"}])


def test_real_generated_certificate_covers_ip_reuses_ca_and_private_permissions(tmp_path):
    import subprocess
    module = launcher()
    cert, key, ca = module.prepare_lan_https(tmp_path / "certs", "192.168.8.8")
    subprocess.run(["openssl", "verify", "-CAfile", str(ca), "-verify_ip", "192.168.8.8", str(cert)], check=True, capture_output=True)
    original_ca, original_key, original_cert = ca.read_bytes(), key.read_bytes(), cert.read_bytes()
    assert key.stat().st_mode & 0o777 == 0o600
    assert (ca.parent / "phone-root-ca.key").stat().st_mode & 0o777 == 0o600
    module.prepare_lan_https(ca.parent, "192.168.8.8")
    assert ca.read_bytes() == original_ca and key.read_bytes() == original_key and cert.read_bytes() == original_cert
    module.prepare_lan_https(ca.parent, "192.168.8.9")
    assert ca.read_bytes() == original_ca
    subprocess.run(["openssl", "verify", "-CAfile", str(ca), "-verify_ip", "192.168.8.9", str(cert)], check=True, capture_output=True)


def test_automatic_https_origin_matches_browser_for_default_tls_port():
    assert launcher().lan_origin("192.168.8.8", 443) == "https://192.168.8.8"
    assert launcher().lan_origin("192.168.8.8", 8443) == "https://192.168.8.8:8443"


def test_static_route_without_prefsrc_uses_actual_interface_address():
    routes = [{"dev": "enp3s0", "gateway": "192.168.8.1"}]
    interfaces = [{"ifname": "enp3s0", "addr_info": [{"family": "inet", "local": "192.168.8.20", "scope": "global"}]}]
    assert launcher().choose_lan_address(routes, interfaces) == "192.168.8.20"
