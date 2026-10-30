"""Show reviewed GitHub About metadata; --apply explicitly updates this repository."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "DattaDhebe/codeme"
API_ROOT = "https://api.github.com/repos/" + REPOSITORY


def read_metadata(path: Path = ROOT / ".github/repository-metadata.json") -> dict:
    data = json.loads(path.read_text(encoding="utf8"))
    if (not isinstance(data, dict) or set(data) != {"repository", "description", "homepage", "topics"}
            or data["repository"] != REPOSITORY or data["homepage"] != "https://www.dhebe.com/"
            or not isinstance(data["description"], str) or not 1 <= len(data["description"]) <= 350
            or not isinstance(data["topics"], list) or not 1 <= len(data["topics"]) <= 20
            or any(not isinstance(topic, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,49}", topic) for topic in data["topics"])
            or len(set(data["topics"])) != len(data["topics"])):
        raise ValueError("Repository metadata must match the reviewed CodeMe repository, homepage and GitHub field limits")
    return data


def github_token() -> str:
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        try:
            result = subprocess.run(["gh", "auth", "token", "--hostname", "github.com"], capture_output=True,
                                    text=True, timeout=10, check=False)
            token = result.stdout.strip() if result.returncode == 0 else None
        except (OSError, subprocess.TimeoutExpired):
            token = None
    if not token or any(character.isspace() for character in token):
        raise ValueError("Authenticate GitHub CLI, or supply GH_TOKEN/GITHUB_TOKEN with repository administration permission. Do not place tokens in source or command arguments.")
    return token


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def github_request(opener, token: str, method: str, suffix: str = "", payload: dict | None = None) -> dict:
    request = Request(API_ROOT + suffix, method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10",
                 "User-Agent": "CodeMe-Repository-Setup"})
    with opener.open(request, timeout=15) as response:
        return json.load(response)


def apply_metadata(data: dict, token: str, opener=None) -> dict:
    opener = opener or build_opener(ProxyHandler({}), NoRedirect())
    current = github_request(opener, token, "GET")
    if current.get("full_name") != REPOSITORY or current.get("permissions", {}).get("admin") is not True:
        raise ValueError("Authenticated account must administer the exact CodeMe repository before About metadata is changed")
    desired = {key: data[key] for key in ("description", "homepage")}
    if any(current.get(key) != value for key, value in desired.items()):
        github_request(opener, token, "PATCH", payload=desired)
    topics = github_request(opener, token, "GET", "/topics")
    if set(topics.get("names", [])) != set(data["topics"]):
        github_request(opener, token, "PUT", "/topics", {"names": data["topics"]})
    final = github_request(opener, token, "GET")
    final_topics = github_request(opener, token, "GET", "/topics")
    if any(final.get(key) != value for key, value in desired.items()) or set(final_topics.get("names", [])) != set(data["topics"]):
        raise ValueError("GitHub did not confirm all requested About fields; inspect the repository before retrying")
    return {"status": "applied", **data}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Update and verify CodeMe description, homepage and topics on GitHub.")
    args = parser.parse_args(argv)
    try:
        metadata = read_metadata()
        result = apply_metadata(metadata, github_token()) if args.apply else {"status": "plan", **metadata}
        print(json.dumps(result, indent=2))
        return 0
    except HTTPError as error:
        print(f"GitHub metadata was not fully applied (HTTP {error.code}). Verify authentication and inspect current About fields before retrying.")
    except (OSError, ValueError, URLError) as error:
        # Provider response bodies and authentication secrets are never printed.
        print("Repository setup needs attention: " + str(error))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
