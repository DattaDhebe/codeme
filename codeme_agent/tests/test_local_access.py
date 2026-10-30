import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from codeme_agent.config import Settings
from codeme_agent.local_access import LocalAccessMiddleware, validate_local_url


@pytest.mark.parametrize("url", [
    "http://localhost:11434", "http://127.0.0.1:11434/", "http://[::1]:11434",
])
def test_local_model_endpoints_are_allowed(url):
    assert validate_local_url(url) == url


@pytest.mark.parametrize("url", [
    "https://api.example.com", "http://192.168.1.20:11434", "http://0.0.0.0:11434",
    "http://localhost.evil.example", "http://localhost@evil.example",
    "http://evil.example@localhost", "http://localhost/?token=secret",
    "http://localhost/#fragment", "file:///tmp/model", "http://127.0.0.1:0",
    "http://127.0.0.1:99999", "http://local host", "http://localhost\\@evil.example",
    "http://localhost/?", "http://localhost/#", "http://localhost/path\x00tail",
    "http://localhost/path\x7ftail",
])
def test_nonlocal_or_ambiguous_model_endpoints_are_rejected(url):
    with pytest.raises(ValueError):
        validate_local_url(url)


@pytest.mark.parametrize("configuration", [
    {"host": "0.0.0.0"}, {"host": "192.168.1.20"},
    {"ollama_url": "https://api.example.com"},
    {"cors_origins": ["*"]}, {"cors_origins": ["https://evil.example"]},
    {"cors_origins": ["http://localhost:4200/path"]}, {"allow_unc_paths": True},
])
def test_settings_enforce_local_execution(configuration):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **configuration)


@pytest.fixture
def local_app():
    app = FastAPI()
    app.state.calls = 0

    @app.post("/touch")
    def touch():
        app.state.calls += 1
        return {"ok": True}

    app.add_middleware(LocalAccessMiddleware, allowed_origins=["http://localhost:4200"])
    return app


def test_local_extension_and_browser_requests_can_access_api(local_app):
    client = TestClient(local_app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000))
    assert client.post("/touch").status_code == 200
    assert client.post("/touch", headers={"Origin": "http://localhost:4200"}).status_code == 200
    assert client.post("/touch", headers={"Origin": "http://127.0.0.1:8000"}).status_code == 200
    assert local_app.state.calls == 3


@pytest.mark.parametrize("origin", [
    "https://evil.example", "http://localhost:9999", "null",
    "http://localhost:4200/evil", "http://localhost:4200?query=1",
])
def test_foreign_simple_posts_cannot_mutate_local_state(local_app, origin):
    client = TestClient(local_app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000))
    assert client.post("/touch", headers={"Origin": origin}).status_code == 403
    assert local_app.state.calls == 0


def test_remote_peer_is_rejected_even_when_bound_to_all_interfaces(local_app):
    client = TestClient(local_app, base_url="http://127.0.0.1:8000", client=("192.168.1.20", 50000))
    assert client.post("/touch").status_code == 403
    assert local_app.state.calls == 0


def test_dns_rebinding_host_is_rejected(local_app):
    client = TestClient(local_app, base_url="http://evil.example:8000", client=("127.0.0.1", 50000))
    assert client.post("/touch").status_code == 403
    assert local_app.state.calls == 0


def test_ipv6_loopback_is_supported(local_app):
    # The installed TestClient transport cannot parse IPv6 in its base URL;
    # send the real IPv6 authority header and peer through its IPv4 transport.
    client = TestClient(local_app, base_url="http://127.0.0.1:8000", client=("::1", 50000))
    assert client.post("/touch", headers={"Host": "[::1]:8000"}).status_code == 200
