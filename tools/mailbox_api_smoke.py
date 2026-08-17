#!/usr/bin/env python3
"""Cloud Mail mailbox-tools smoke test.

This script exercises the user-facing flow without depending on browser state:

  login -> batch-create -> create public retrieval URL -> fetch code -> revoke

It intentionally uses only Python's standard library so it can run from a clean
checkout. Credentials and the base URL are read from environment variables by
default (see ``--help``). Tokens/passwords are never printed in full.

The script is compatible with the Cloud Mail API envelope ``{code,message,data}``.
A retrieval URL is expected to be returned as ``codeUrl`` (the script also
accepts ``url``/``retrievalUrl`` for older deployments).
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import string
import sys
import time
from dataclasses import dataclass
from typing import Any, Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen


class ApiFailure(RuntimeError):
    pass


@dataclass
class HttpResult:
    status: int
    body: Any
    raw: str


def _mask(value: Optional[str], keep: int = 4) -> str:
    if not value:
        return "<empty>"
    if len(value) <= keep * 2:
        return "*" * len(value)
    return f"{value[:keep]}…{value[-keep:]}"


def _json_or_text(raw: str) -> Any:
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return raw


def request_json(
    url: str,
    method: str = "GET",
    payload: Optional[Mapping[str, Any]] = None,
    auth: Optional[str] = None,
    expected: tuple[int, ...] = (200,),
    timeout: float = 25.0,
) -> HttpResult:
    headers = {"Accept": "application/json"}
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if auth:
        # Cloud Mail expects the raw JWT in Authorization; do not add Bearer.
        headers["Authorization"] = auth
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
            result = HttpResult(response.status, _json_or_text(raw), raw)
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        result = HttpResult(exc.code, _json_or_text(raw), raw)
    except (URLError, TimeoutError) as exc:
        raise ApiFailure(f"request {method} {url} failed: {exc}") from exc
    if result.status not in expected:
        detail = result.body if isinstance(result.body, (dict, list)) else result.raw[:500]
        raise ApiFailure(f"{method} {url} -> HTTP {result.status}: {detail}")
    return result


def envelope_data(result: HttpResult, *, allow_plain: bool = False) -> Any:
    """Extract ``data`` and turn API-level non-200 envelopes into failures."""
    body = result.body
    if isinstance(body, dict) and "code" in body:
        code = body.get("code")
        if code != 200:
            raise ApiFailure(f"API error code={code}: {body.get('message', body)}")
        return body.get("data")
    if allow_plain:
        return body
    raise ApiFailure(f"expected API envelope, got: {body!r}")


def first_mapping(value: Any) -> Optional[Mapping[str, Any]]:
    if isinstance(value, Mapping):
        return value
    if isinstance(value, list) and value and isinstance(value[0], Mapping):
        return value[0]
    return None


def account_id_from(data: Any) -> Optional[int]:
    if isinstance(data, Mapping):
        for key in ("accountId", "account_id", "id"):
            value = data.get(key)
            if value is not None:
                try:
                    return int(value)
                except (TypeError, ValueError):
                    pass
        for key in ("created", "accounts", "list"):
            found = account_id_from(data.get(key))
            if found is not None:
                return found
    elif isinstance(data, list):
        for item in data:
            found = account_id_from(item)
            if found is not None:
                return found
    return None


def token_id_from(data: Any) -> Optional[str]:
    item = first_mapping(data)
    if not item:
        return None
    for key in ("id", "tokenId", "token_id"):
        if item.get(key) is not None:
            return str(item[key])
    return None


def code_url_from(data: Any) -> Optional[str]:
    item = first_mapping(data)
    if not item:
        return None
    for key in ("codeUrl", "code_url", "retrievalUrl", "url"):
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def normalize_api_base(raw: str) -> str:
    raw = raw.strip().rstrip("/")
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        raise ApiFailure(f"invalid --base-url: {raw!r}")
    # All application APIs are mounted below /api. Accept either form.
    if not parsed.path.rstrip("/").endswith("/api"):
        raw += "/api"
    return raw.rstrip("/")


def random_label() -> str:
    return "smoke-" + "".join(secrets.choice(string.ascii_lowercase) for _ in range(8))


def run(args: argparse.Namespace) -> int:
    base = normalize_api_base(args.base_url)
    email = args.email
    password = args.password
    if not email or not password:
        raise ApiFailure("set CLOUD_MAIL_EMAIL and CLOUD_MAIL_PASSWORD (or pass --email/--password)")

    print(f"[1/7] login {email}")
    login = request_json(f"{base}/login", "POST", {"email": email, "password": password})
    login_data = envelope_data(login)
    token = login_data.get("token") if isinstance(login_data, Mapping) else None
    if not token:
        raise ApiFailure(f"login response has no token: {login.body!r}")
    print(f"      JWT {_mask(str(token))}")

    account_id: Optional[int] = None
    created_data: Any = None
    if not args.skip_batch:
        print(f"[2/7] batch-create count={args.count} domain={args.domain}")
        payload: dict[str, Any] = {
            "count": args.count,
            "domain": args.domain,
            "length": args.length,
        }
        if args.prefix:
            payload["prefix"] = args.prefix
        batch = request_json(f"{base}/mailbox-tools/batch-create", "POST", payload, token)
        created_data = envelope_data(batch)
        account_id = account_id_from(created_data)
        created_count = created_data.get("createdCount") if isinstance(created_data, Mapping) else None
        print(f"      createdCount={created_count!r}, accountId={account_id!r}")
    else:
        print("[2/7] batch-create skipped")

    if args.account_id is not None:
        account_id = args.account_id
    if account_id is None:
        # Use the first account owned by the logged-in user as a fallback.
        print("      locating an existing account")
        accounts = request_json(
            f"{base}/account/list?accountId=0&size=1&lastSort=9999999999",
            "GET",
            auth=token,
        )
        account_data = envelope_data(accounts)
        account_id = account_id_from(account_data)
    if account_id is None:
        raise ApiFailure("no accountId available; pass --account-id")

    print(f"[3/7] list retrieval tokens for accountId={account_id}")
    token_list = request_json(f"{base}/mailbox-tools/tokens", "GET", auth=token)
    envelope_data(token_list)

    print("[4/7] create retrieval URL")
    created_token = request_json(
        f"{base}/mailbox-tools/tokens",
        "POST",
        {"accountId": account_id, "label": args.label or random_label()},
        token,
    )
    token_data = envelope_data(created_token)
    token_id = token_id_from(token_data)
    code_url = code_url_from(token_data)
    if not token_id or not code_url:
        raise ApiFailure(f"token response missing id/codeUrl: {created_token.body!r}")
    print(f"      tokenId={_mask(token_id)}, codeUrl={code_url}")

    print("[5/7] fetch retrieval URL")
    fetched = request_json(code_url, "GET", expected=(200,))
    fetched_data = envelope_data(fetched)
    if not isinstance(fetched_data, Mapping):
        raise ApiFailure(f"unexpected retrieval data: {fetched_data!r}")
    print(
        "      found={found!r}, code={code!r}, emailId={emailId!r}".format(
            found=fetched_data.get("found"),
            code=fetched_data.get("code"),
            emailId=fetched_data.get("emailId"),
        )
    )
    if args.require_code and not fetched_data.get("code"):
        raise ApiFailure("retrieval succeeded but no code is currently available; deliver a test email then rerun")

    if args.skip_revoke:
        print("[6/7] revoke skipped (--skip-revoke)")
        print("[7/7] PASS (token left active)")
        return 0

    print("[6/7] revoke retrieval token")
    deleted = request_json(
        f"{base}/mailbox-tools/tokens/{token_id}",
        "DELETE",
        auth=token,
        expected=(200, 204),
    )
    if deleted.status == 200:
        envelope_data(deleted)

    print("[7/7] verify revoked URL")
    revoked = request_json(code_url, "GET", expected=(200, 401, 403, 404))
    if revoked.status == 200:
        body = revoked.body
        if isinstance(body, Mapping) and body.get("code") in (401, 403, 404):
            pass
        else:
            raise ApiFailure(f"revoked URL still returned success: {body!r}")
    print(f"      revoked request status={revoked.status}; PASS")
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--base-url", default=os.getenv("CLOUD_MAIL_BASE", "https://mail.salvadawn.com/api"), help="site URL or /api URL")
    p.add_argument("--email", default=os.getenv("CLOUD_MAIL_EMAIL"), help="login email")
    p.add_argument("--password", default=os.getenv("CLOUD_MAIL_PASSWORD"), help="login password")
    p.add_argument("--domain", default=os.getenv("CLOUD_MAIL_DOMAIN", "salvadawn.com"), help="domain sent to batch-create")
    p.add_argument("--count", type=int, default=int(os.getenv("CLOUD_MAIL_COUNT", "1")), help="number of random accounts")
    p.add_argument("--length", type=int, default=int(os.getenv("CLOUD_MAIL_PREFIX_LENGTH", "10")), help="random local-part length")
    p.add_argument("--prefix", default=os.getenv("CLOUD_MAIL_PREFIX"), help="optional local-part prefix")
    p.add_argument("--label", default=os.getenv("CLOUD_MAIL_TOKEN_LABEL"), help="retrieval token label")
    p.add_argument("--account-id", type=int, default=None, help="use an existing account instead of created account")
    p.add_argument("--skip-batch", action="store_true", help="do not create an account")
    p.add_argument("--skip-revoke", action="store_true", help="leave retrieval token active")
    p.add_argument("--require-code", action="store_true", help="fail if current retrieval response has no code")
    return p


if __name__ == "__main__":
    try:
        raise SystemExit(run(parser().parse_args()))
    except ApiFailure as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(2)
