"""Live GitHub capability interface for a future read-only preflight.

This module records the intended identity, the authorized resource boundary,
and the read-only checks a later preflight would run. It does not open a
socket, does not read a credential, does not execute a token, and does not
construct a Redis client. No check below is a live measurement.

Synthetic token_facts probes are a different interface and live in
pr_board_adapter. A passing synthetic probe is not evidence that any check
here has run, and it does not authorize a Redis write or a production mode.
"""

from __future__ import annotations

import ops_pr_board as board


class LiveCapabilityUnavailable(RuntimeError):
    """A live GitHub call was requested and this source drop does not perform one."""


# Intended identity for a later read-only preflight. This process does not
# hold that installation token. The human login is refused.
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
    return {
        "identity": dict(INTENDED_IDENTITY),
        "existing_access": dict(EXISTING_ACCESS),
        "boundary": boundary,
        "checks": tuple(dict(item) for item in CHECKS),
    }


class LiveReadOnlyGitHub:
    """Read-only GitHub preflight plan. The checks are not executed here.

    Unverified live prerequisites, named and not called:
    the token type would be an installation token or a fine-grained token,
    the token would have pull read on the three board repos and no write
    scope, and each repo would return HTTP 200 with a list. assess does not
    call those methods and does not contact GitHub.
    """

    def token_type(self):
        raise LiveCapabilityUnavailable("live token type is an unverified prerequisite")

    def scopes(self):
        raise LiveCapabilityUnavailable("live token scope is an unverified prerequisite")

    def list_pulls(self, repo):
        raise LiveCapabilityUnavailable("live pull list is an unverified prerequisite")

    def assess(self):
        plan = _copy_plan()
        plan["ok"] = False
        plan["reason"] = "live GitHub capability is an unverified prerequisite"
        plan["network"] = False
        return plan
