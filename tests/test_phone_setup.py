from fastapi.testclient import TestClient
from colorlab.app import create_app


def test_phone_setup_exposes_only_public_ca_and_real_configured_url(tmp_path, monkeypatch):
    ca = tmp_path / "root.crt"
    ca.write_text("synthetic-public-cert-fixture")
    monkeypatch.setenv("COLORLAB_PHONE_CA", str(ca))
    with TestClient(create_app(origin="https://192.168.8.8:8443")) as client:
        info = client.get("/api/connection-info")
        assert info.status_code == 200
        assert info.json() == {"origin": "https://192.168.8.8:8443", "https": True, "phoneSetupUrl": "/phone-setup", "publicCaAvailable": True}
        response = client.get("/phone-setup")
        assert response.status_code == 200
        assert "https://192.168.8.8:8443" in response.text
        assert "phone-root-ca.crt" in response.text
        assert client.get("/phone-root-ca.crt").text == "synthetic-public-cert-fixture"
        assert client.get("/phone-root-ca.key").status_code == 404


def test_setup_without_ca_does_not_publish_private_path_or_fake_trust(monkeypatch):
    monkeypatch.delenv("COLORLAB_PHONE_CA", raising=False)
    with TestClient(create_app(origin="http://localhost:8443")) as client:
        assert client.get("/phone-root-ca.crt").status_code == 404
        assert client.get("/api/connection-info").json()["publicCaAvailable"] is False
