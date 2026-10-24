"""Loopback-only transport boundaries for the local CodeMe application."""

from ipaddress import ip_address
from urllib.parse import urlsplit

from starlette.responses import JSONResponse


def is_loopback_host(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        address = ip_address(host)
        if getattr(address, "ipv4_mapped", None):
            address = address.ipv4_mapped
        return address.is_loopback
    except ValueError:
        return False


def validate_local_url(value: str) -> str:
    """Reject remote URLs and ambiguous authorities without resolving DNS."""
    value = str(value)
    try:
        parsed = urlsplit(value)
        port = parsed.port
        valid = (
            parsed.scheme in {"http", "https"}
            and parsed.hostname is not None
            and is_loopback_host(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
            and "?" not in value
            and "#" not in value
            and not any(ord(character) < 32 or ord(character) == 127 for character in value)
            and not any(character.isspace() for character in value)
            and "\\" not in value
            and (port is None or 1 <= port <= 65535)
        )
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("CodeMe requires an HTTP(S) URL on localhost or a loopback IP address")
    return value


def _origin(value: str) -> tuple[str, str, int]:
    validate_local_url(value)
    parsed = urlsplit(value)
    if parsed.path not in {"", "/"}:
        raise ValueError("Origins cannot include a path")
    return parsed.scheme, parsed.hostname.lower(), parsed.port or (443 if parsed.scheme == "https" else 80)


def validate_local_origin(value: str) -> str:
    _origin(value)
    return value


class LocalAccessMiddleware:
    """Reject remote peers, DNS rebinding, and cross-origin local API access.

    CORS alone does not stop a foreign page from sending a simple POST request.
    Validate the Origin before any route can access local files or change state.
    """

    def __init__(self, app, allowed_origins: list[str]):
        self.app = app
        self.allowed_origins = {_origin(value) for value in allowed_origins}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        client = scope.get("client")
        if not client or not is_loopback_host(client[0]):
            await JSONResponse({"detail": "CodeMe only accepts connections from this machine"}, status_code=403)(scope, receive, send)
            return
        headers = scope.get("headers", [])
        hosts = [value.decode("latin-1") for key, value in headers if key.lower() == b"host"]
        origins = [value.decode("latin-1") for key, value in headers if key.lower() == b"origin"]
        try:
            if len(hosts) != 1 or len(origins) > 1:
                raise ValueError("Ambiguous request authority")
            request_origin = _origin(f"{scope.get('scheme', 'http')}://{hosts[0]}")
            if origins and _origin(origins[0]) not in self.allowed_origins | {request_origin}:
                raise ValueError("Unapproved browser origin")
        except ValueError:
            await JSONResponse({"detail": "Use a loopback backend URL and an approved local browser origin"}, status_code=403)(scope, receive, send)
            return
        await self.app(scope, receive, send)
