import io
import json

import pytest

from scripts import configure_repository as repo


def test_metadata_plan_is_offline_and_never_loads_credentials(monkeypatch, capsys):
    monkeypatch.setattr(repo, "github_token", lambda: pytest.fail("Plan must not load authentication"))
    assert repo.main([]) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "plan"


def test_metadata_cannot_change_target_or_include_unreviewed_settings(tmp_path):
    data = repo.read_metadata()
    data["repository"] = "another/account"
    target = tmp_path / "metadata.json"
    target.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        repo.read_metadata(target)
    data["repository"] = repo.REPOSITORY
    data["visibility"] = "private"
    target.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        repo.read_metadata(target)


class GitHub:
    def __init__(self, *, admin=True):
        self.current = {"full_name": repo.REPOSITORY, "permissions": {"admin": admin}, "description": "Old", "homepage": ""}
        self.topics = []
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request.method, request.full_url))
        if request.method == "PATCH":
            self.current.update(json.loads(request.data))
        if request.method == "PUT":
            self.topics = json.loads(request.data)["names"]
        payload = {"names": self.topics} if request.full_url.endswith("/topics") else self.current
        return io.BytesIO(json.dumps(payload).encode())


def test_about_update_verifies_target_and_preserves_unrelated_settings():
    api = GitHub()
    result = repo.apply_metadata(repo.read_metadata(), "fixture-token", api)
    assert result["status"] == "applied"
    assert [method for method, _ in api.calls] == ["GET", "PATCH", "GET", "PUT", "GET", "GET"]
    assert all(url.startswith(repo.API_ROOT) for _, url in api.calls)
    assert repo.apply_metadata(repo.read_metadata(), "fixture-token", api)["status"] == "applied"
    assert [method for method, _ in api.calls].count("PATCH") == 1
    assert [method for method, _ in api.calls].count("PUT") == 1


def test_about_update_without_admin_permission_never_mutates():
    api = GitHub(admin=False)
    with pytest.raises(ValueError, match="administer"):
        repo.apply_metadata(repo.read_metadata(), "fixture-token", api)
    assert [method for method, _ in api.calls] == ["GET"]
