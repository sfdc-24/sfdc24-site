"""Live GitHub capability interface for a future read-only preflight.

The methods below are the real check this process would eventually perform:
token type, token scope, and a list read of the three repositories. Those
calls are unverified prerequisites. This module does not open a socket, does
not read a credential, and does not construct a Redis client.

Synthetic token_facts probes are a different interface and live in
pr_board_adapter. Nothing here inspects those probes.
"""

from __future__ import annotations


class LiveCapabilityUnavailable(RuntimeError):
    """A live GitHub call was requested and this source drop does not perform one."""


class LiveReadOnlyGitHub:
    """Interface for a read-only GitHub preflight that is not implemented here.

    Unverified live prerequisites:
    the token type would be an installation token or a fine-grained token,
    the token would have no write scope, and each of conference, Blackboard,
    and sfdc24-site would return HTTP 200 with a list. assess does not call
    those methods and does not contact GitHub.
    """

    def token_type(self):
        raise LiveCapabilityUnavailable("live token type is an unverified prerequisite")

    def scopes(self):
        raise LiveCapabilityUnavailable("live token scope is an unverified prerequisite")

    def list_pulls(self, repo):
        raise LiveCapabilityUnavailable("live pull list is an unverified prerequisite")

    def assess(self):
        return {
            "ok": False,
            "reason": "live GitHub capability is an unverified prerequisite",
            "network": False,
        }
