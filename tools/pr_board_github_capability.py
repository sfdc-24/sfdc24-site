"""Live GitHub capability interface for a read-only preflight.

The loader reads the Cursor-managed installation token that is already on
the machine. It does not mint a credential, does not open a socket, and does
not put a secret into a result, an exception, or a transport request.

Synthetic token_facts probes are a different interface and live in
pr_board_adapter. A passing synthetic probe is not evidence that any check
here has run, and it does not authorize a Redis write or a production mode.
"""

from __future__ import annotations

import re
from pathlib import Path

import ops_pr_board as board


class LiveCapabilityUnavailable(RuntimeError):
    """A live GitHub call was requested and this source drop does not perform one."""


# Aya verified this installation. The loader names it when the Cursor-managed
# ghs_ pair is present. It is not read out of the secret.
VERIFIED_INSTALLATION_ID = 162673035

DEFAULT_HOSTS_PATH = Path.home() / ".config" / "gh" / "hosts.yml"
DEFAULT_GITCONFIG_PATH = Path.home() / ".gitconfig"

_GHS_VALUE = re.compile(r"ghs_[A-Za-z0-9]+")
_OTHER_VALUE = re.compile(r"(?:github_pat_|ghp_|gho_|ghu_|ghr_|ghd_)[A-Za-z0-9_]+")

# Intended identity for a later read-only preflight. Loading the local ghs_
# pair does not by itself prove this subject id. The human login is refused.
INTENDED_IDENTITY = {
    "login": "cursor[bot]",
    "id": 206951365,
    "type": "Bot",
    "principal": "cursor",
    "rejected_login": "sfdc-24",
}

# What this source can already say without calling GitHub or Redis.
# Git access to sfdc24-site from the runtime is not a capability check and
# is not recorded as pull read on the three repositories.
EXISTING_ACCESS = {
    "installation_token_for_206951365": False,
    "token_type_read": False,
    "scope_read": False,
    "list_pulls_read": False,
    "redis_client": False,
}

# GitHub this step is a read of open pulls on the three board repos.
# Redis this step is no client. A later proof write, after a separate GO,
# may touch only the proof namespace and proof head. Production stays refused.
# The receipt contract remains redis_gov.complete_receipt.
AUTHORIZED_BOUNDARY = {
    "github": "read-only list of open pulls",
    "repos": board.REPOS,
    "redis_read": None,
    "redis_write": board.PROOF_NAMESPACE,
    "redis_head": board.PROOF_HEAD,
    "production_namespace": board.NAMESPACE,
    "production_head": board.HEAD_KEY,
    "receipt": "redis_gov.complete_receipt",
    "production_refused": True,
    "separate_proof_go_required": True,
}

# Status is missing or unverified. Nothing here is ok. These rows name the
# permission this process does not have. They are not a fresh measurement
# and they do not come from synthetic token_facts.
CHECKS = (
    {
        "name": "identity",
        "status": "missing",
        "have": "this module holds no installation token",
        "need": "an installation token for cursor[bot] id 206951365 presented to this process",
    },
    {
        "name": "token_type",
        "status": "unverified",
        "have": "token_type is not executed",
        "need": "installation or fine-grained",
    },
    {
        "name": "scopes",
        "status": "unverified",
        "have": "scopes is not executed",
        "need": (
            "pull_requests:read on sfdc-24/conference, sfdc-24/Blackboard, "
            "and sfdc-24/sfdc24-site; contents:write and pull_requests:write absent"
        ),
    },
    {
        "name": "list_pulls",
        "status": "unverified",
        "have": "list_pulls is not executed",
        "need": "HTTP 200 and a list for each repo in the boundary",
    },
)


def _copy_plan():
    boundary = dict(AUTHORIZED_BOUNDARY)
    boundary["repos"] = tuple(AUTHORIZED_BOUNDARY["repos"])
    boundary["installation_id"] = VERIFIED_INSTALLATION_ID
    return {
        "identity": dict(INTENDED_IDENTITY),
        "existing_access": dict(EXISTING_ACCESS),
        "boundary": boundary,
        "checks": tuple(dict(item) for item in CHECKS),
    }


class _RedactedInstallationToken:
    """In-memory ghs_ value. Public text never includes the secret."""

    __slots__ = ("_value",)

    def __init__(self, value):
        self._value = value

    def __str__(self):
        return "ghs_<redacted>"

    def __repr__(self):
        return "RedactedInstallationToken('ghs_<redacted>')"

    def __format__(self, _spec):
        return "ghs_<redacted>"


def _credential_values(text, marker):
    """Return ghs_ values on credential lines, and whether another token class appears."""
    found = []
    other = False
    for line in text.splitlines():
        if marker not in line.lower():
            continue
        found.extend(_GHS_VALUE.findall(line))
        if _OTHER_VALUE.search(line):
            other = True
    return found, other


def load_cursor_managed_installation_token(hosts_path, gitconfig_path):
    """Load the existing Cursor-managed ghs_ pair. Never creates a credential.

    Both stores must contain the same ghs_ value, the gitconfig must be the
    Cursor-managed rewrite, and the gh user label must be cursor. A PAT or
    any other token class is refused. The returned object redacts the secret.
    """
    hosts_file = Path(hosts_path)
    gitconfig_file = Path(gitconfig_path)
    if not hosts_file.is_file() or not gitconfig_file.is_file():
        return None
    try:
        hosts_text = hosts_file.read_text(encoding="utf-8")
        gitconfig_text = gitconfig_file.read_text(encoding="utf-8")
    except OSError as exc:
        raise LiveCapabilityUnavailable("cursor-managed credential store could not be read") from exc
    hosts_values, hosts_other = _credential_values(hosts_text, "oauth_token")
    git_values, git_other = _credential_values(gitconfig_text, "x-access-token")
    if hosts_other or git_other:
        raise LiveCapabilityUnavailable("cursor-managed store is not an installation token")
    if not hosts_values or not git_values:
        return None
    agreed = set(hosts_values)
    if len(agreed) != 1 or agreed != set(git_values):
        raise LiveCapabilityUnavailable("cursor-managed installation stores do not agree")
    managed = re.search(r"managedghconfig\s*=\s*true\b", gitconfig_text) is not None
    labeled = re.search(r"(?m)^\s*user:\s*cursor\s*$", hosts_text) is not None
    if not managed or not labeled:
        return None
    return _RedactedInstallationToken(next(iter(agreed)))


def _http_404(response):
    return isinstance(response, dict) and response.get("status") == 404


def _interpret_http(response, repo=None):
    """Describe an injected response. A 404 does not establish a permission cause."""
    if not isinstance(response, dict):
        return {"status": None, "permission_proven": False, "reason": "injected response was not a document"}
    status = response.get("status")
    body = response.get("body")
    result = {"status": status, "permission_proven": False}
    if repo is not None:
        result["repo"] = repo
    if status == 404:
        result["reason"] = "http 404 does not establish a permission cause"
        return result
    if status == 200 and isinstance(body, list):
        result["count"] = len(body)
        result["reason"] = "injected list returned HTTP 200"
        return result
    if status == 200 and isinstance(body, dict) and body.get("pull_read") is True and body.get("write") is False:
        result["read_only"] = True
        result["reason"] = "injected scope document is read-only"
        return result
    result["reason"] = "injected response did not satisfy the read-only check"
    return result


class LiveReadOnlyGitHub:
    """Load the Cursor-managed installation token and evaluate injected reads.

    With no transport, scopes and list_pulls are not executed and assess stays
    refused, so a loaded token cannot open Redis. A transport is a test double.
    This class does not import a network library and does not mint a token.
    """

    def __init__(self, hosts_path=None, gitconfig_path=None, transport=None):
        self._hosts_path = DEFAULT_HOSTS_PATH if hosts_path is None else Path(hosts_path)
        self._gitconfig_path = DEFAULT_GITCONFIG_PATH if gitconfig_path is None else Path(gitconfig_path)
        self._transport = transport
        self._loaded = None
        self._loaded_once = False

    def _token(self):
        if not self._loaded_once:
            self._loaded = load_cursor_managed_installation_token(self._hosts_path, self._gitconfig_path)
            self._loaded_once = True
        return self._loaded

    def _require_token(self):
        if self._token() is None:
            raise LiveCapabilityUnavailable("cursor-managed installation token is absent")
        return self._token()

    def _request(self, payload):
        self._require_token()
        if self._transport is None:
            raise LiveCapabilityUnavailable("live GitHub read is not executed without an injected transport")
        if not isinstance(payload, dict):
            raise LiveCapabilityUnavailable("injected transport payload is not a document")
        # The secret stays in the redacted holder. The transport receives the op only.
        return self._transport(dict(payload))

    def token_type(self):
        self._require_token()
        return {
            "type": "installation",
            "class": "ghs",
            "installation_id": VERIFIED_INSTALLATION_ID,
        }

    def scopes(self):
        response = self._request({"op": "scopes"})
        return _interpret_http(response)

    def list_pulls(self, repo):
        if repo not in board.REPOS:
            raise LiveCapabilityUnavailable("repository is outside the board boundary")
        response = self._request({"op": "list_pulls", "repo": repo})
        return _interpret_http(response, repo=repo)

    def assess(self):
        plan = _copy_plan()
        plan["ok"] = False
        plan["network"] = False
        try:
            loaded = self._token()
        except LiveCapabilityUnavailable as exc:
            plan["reason"] = str(exc)
            return plan
        if loaded is None:
            plan["reason"] = "live GitHub capability is an unverified prerequisite"
            return plan
        access = dict(plan["existing_access"])
        access["cursor_managed_ghs_loaded"] = True
        access["installation_id"] = VERIFIED_INSTALLATION_ID
        plan["existing_access"] = access
        checks = []
        for item in plan["checks"]:
            row = dict(item)
            if row["name"] == "identity":
                row["status"] = "loaded"
                row["have"] = "cursor-managed ghs_ token loaded from the local stores"
                row["installation_id"] = VERIFIED_INSTALLATION_ID
            elif row["name"] == "token_type":
                row["status"] = "loaded"
                row["have"] = "prefix class ghs"
                row["installation_id"] = VERIFIED_INSTALLATION_ID
            checks.append(row)
        plan["checks"] = tuple(checks)
        plan["reason"] = "cursor-managed installation token loaded; scopes and pull lists are unverified"
        if self._transport is None:
            return plan
        scope = self.scopes()
        pulls = [self.list_pulls(repo) for repo in board.REPOS]
        plan["injected"] = {"scopes": scope, "pulls": pulls}
        plan["network"] = False
        plan["reason"] = "cursor-managed installation token loaded; injected reads do not authorize a write"
        return plan
