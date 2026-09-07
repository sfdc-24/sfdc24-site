#!/usr/bin/env python3
"""Deterministic, fail-closed publisher for unlisted GitHub Pages prototypes."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import uuid
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable


SCHEMA_VERSION = "blackboard.prototype.v1"
STATE_NAME = "prototype.json"
CONTENT_DOMAIN = b"blackboard.prototype.content.v1\0"
ARTIFACT_DOMAIN = b"blackboard.prototype.artifact.v1\0"
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
HEAD_RE = re.compile(r"<head\b[^>]*>", re.IGNORECASE)
RESERVED_META_NAMES = {
    "blackboard-work-id",
    "blackboard-content-digest",
}
FORBIDDEN_SOURCE_PARTS = {".git", ".hg", ".svn"}
FORBIDDEN_SOURCE_NAMES = {".env", ".npmrc", ".pypirc", "id_ed25519", "id_rsa"}
FORBIDDEN_SOURCE_SUFFIXES = {".key", ".p12", ".pem", ".pfx"}


class PublisherError(Exception):
    """Expected, machine-readable publisher failure."""

    def __init__(
        self,
        kind: str,
        message: str,
        *,
        exit_code: int = 2,
        details: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.exit_code = exit_code
        self.details = details or {}


@dataclass(frozen=True)
class Bundle:
    source: Path
    files: tuple[tuple[str, bytes], ...]
    content_digest: str


class _HeadMetadata(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.has_head = False
        self.robots: list[str] = []
        self.viewports: list[str] = []
        self.reserved: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "head":
            self.has_head = True
            return
        if tag != "meta":
            return
        values = {str(key).lower(): (value or "") for key, value in attrs}
        name = values.get("name", "").strip().lower()
        content = values.get("content", "").strip()
        if name == "robots":
            self.robots.append(content)
        elif name == "viewport":
            self.viewports.append(content)
        elif name in RESERVED_META_NAMES:
            self.reserved.append(name)


def _digest_entries(domain: bytes, files: Iterable[tuple[str, bytes]]) -> str:
    digest = hashlib.sha256()
    digest.update(domain)
    for relative_path, content in files:
        path_bytes = relative_path.encode("utf-8")
        digest.update(path_bytes)
        digest.update(b"\0")
        digest.update(str(len(content)).encode("ascii"))
        digest.update(b"\0")
        digest.update(content)
    return f"sha256:{digest.hexdigest()}"


def _validate_work_id(work_id: str) -> str:
    try:
        parsed = uuid.UUID(work_id)
    except (ValueError, AttributeError) as exc:
        raise PublisherError(
            "invalid_work_id",
            "work-id must be a canonical lowercase UUIDv4",
        ) from exc
    if parsed.version != 4 or str(parsed) != work_id:
        raise PublisherError(
            "invalid_work_id",
            "work-id must be a canonical lowercase UUIDv4",
        )
    return work_id


def _validate_expected_digest(expected: str) -> str:
    if not DIGEST_RE.fullmatch(expected):
        raise PublisherError(
            "invalid_content_digest",
            "content-digest must be sha256 followed by 64 lowercase hex characters",
        )
    return expected


def _validate_relative_path(relative_path: str) -> None:
    if not relative_path or relative_path.startswith("/"):
        raise PublisherError("invalid_source_path", "source contains an invalid path")
    if "\\" in relative_path or any(ord(char) < 32 for char in relative_path):
        raise PublisherError(
            "invalid_source_path",
            f"source path is not URL-safe: {relative_path!r}",
        )
    parts = relative_path.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise PublisherError(
            "invalid_source_path",
            f"source path is not normalized: {relative_path!r}",
        )
    lower_parts = [part.lower() for part in parts]
    name = lower_parts[-1]
    if (
        any(part in FORBIDDEN_SOURCE_PARTS for part in lower_parts)
        or name in FORBIDDEN_SOURCE_NAMES
        or name.startswith(".env.")
        or Path(name).suffix in FORBIDDEN_SOURCE_SUFFIXES
    ):
        raise PublisherError(
            "forbidden_source_path",
            f"source contains a credential-prone or repository-control path: {relative_path!r}",
        )


def _scan_html(html_bytes: bytes, relative_path: str) -> tuple[str, _HeadMetadata]:
    try:
        html_text = html_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PublisherError(
            "invalid_html", f"HTML must be UTF-8: {relative_path}"
        ) from exc

    scanner = _HeadMetadata()
    scanner.feed(html_text)
    scanner.close()
    if not scanner.has_head or not HEAD_RE.search(html_text):
        raise PublisherError(
            "invalid_html", f"HTML must contain a head element: {relative_path}"
        )
    if scanner.reserved:
        raise PublisherError(
            "reserved_metadata",
            "source HTML already contains publisher-owned metadata",
            details={
                "meta": ",".join(sorted(set(scanner.reserved))),
                "path": relative_path,
            },
        )

    for value in scanner.robots:
        directives = {
            token.lower()
            for token in re.split(r"[\s,]+", value.strip())
            if token
        }
        if "noindex" not in directives or "index" in directives:
            raise PublisherError(
                "unsafe_robots_metadata",
                f"an existing robots meta tag must contain noindex: {relative_path}",
            )

    for value in scanner.viewports:
        directives = {
            key.strip().lower(): val.strip().lower()
            for item in value.split(",")
            if "=" in item
            for key, val in [item.split("=", 1)]
        }
        if directives.get("width") != "device-width":
            raise PublisherError(
                "unsafe_viewport_metadata",
                f"an existing viewport meta tag must use width=device-width: {relative_path}",
            )

    return html_text, scanner


def read_bundle(source: str | Path) -> Bundle:
    source_path = Path(source).resolve()
    if not source_path.is_dir():
        raise PublisherError("invalid_source", "source must be an existing directory")

    files: list[tuple[str, bytes]] = []
    for path in sorted(source_path.rglob("*"), key=lambda p: p.relative_to(source_path).as_posix()):
        relative_path = path.relative_to(source_path).as_posix()
        _validate_relative_path(relative_path)
        if path.is_symlink():
            raise PublisherError(
                "source_symlink_rejected",
                f"source symlinks are not allowed: {relative_path}",
            )
        if path.is_dir():
            continue
        if not path.is_file():
            raise PublisherError(
                "invalid_source_entry",
                f"source contains a non-regular file: {relative_path}",
            )
        if relative_path == STATE_NAME:
            raise PublisherError(
                "reserved_source_path",
                f"{STATE_NAME} is reserved for publisher state",
            )
        files.append((relative_path, path.read_bytes()))

    file_map = dict(files)
    if "index.html" not in file_map:
        raise PublisherError("missing_index", "source must contain index.html at its root")
    for relative_path, content in files:
        if Path(relative_path).suffix.lower() in {".htm", ".html"}:
            _scan_html(content, relative_path)
    if not files:
        raise PublisherError("empty_source", "source contains no files")

    digest = _digest_entries(CONTENT_DOMAIN, files)
    return Bundle(source=source_path, files=tuple(files), content_digest=digest)


def _render_html(
    html_bytes: bytes,
    relative_path: str,
    work_id: str,
    content_digest: str,
) -> bytes:
    html_text, scanner = _scan_html(html_bytes, relative_path)
    head_match = HEAD_RE.search(html_text)
    if head_match is None:  # guarded in _scan_html; keeps the type checker honest
        raise PublisherError(
            "invalid_html", f"HTML must contain a head element: {relative_path}"
        )

    metadata: list[str] = []
    if not scanner.robots:
        metadata.append('<meta name="robots" content="noindex, nofollow">')
    if not scanner.viewports:
        metadata.append(
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
        )
    metadata.extend(
        [
            f'<meta name="blackboard-work-id" content="{work_id}">',
            (
                '<meta name="blackboard-content-digest" '
                f'content="{content_digest}">'
            ),
        ]
    )
    insertion = "\n" + "\n".join(metadata)
    rendered = html_text[: head_match.end()] + insertion + html_text[head_match.end() :]
    return rendered.encode("utf-8")


def _artifact_files(bundle: Bundle, work_id: str) -> tuple[tuple[str, bytes], ...]:
    rendered: list[tuple[str, bytes]] = []
    for relative_path, content in bundle.files:
        if Path(relative_path).suffix.lower() in {".htm", ".html"}:
            content = _render_html(
                content, relative_path, work_id, bundle.content_digest
            )
        rendered.append((relative_path, content))
    return tuple(rendered)


def _state_payload(
    work_id: str,
    content_digest: str,
    artifact_files: tuple[tuple[str, bytes], ...],
) -> dict[str, object]:
    artifact_digest = _digest_entries(ARTIFACT_DOMAIN, artifact_files)
    return {
        "artifact_digest": artifact_digest,
        "content_digest": content_digest,
        "files": [
            {
                "path": relative_path,
                "sha256": hashlib.sha256(content).hexdigest(),
                "size": len(content),
            }
            for relative_path, content in artifact_files
        ],
        "route": f"/p/{work_id}/",
        "schema_version": SCHEMA_VERSION,
        "work_id": work_id,
    }


def _safe_target(site_root: str | Path, work_id: str) -> tuple[Path, Path]:
    root = Path(site_root).resolve()
    if not root.is_dir():
        raise PublisherError("invalid_site_root", "site-root must be an existing directory")
    p_root = root / "p"
    if p_root.is_symlink():
        raise PublisherError("unsafe_target", "the p directory must not be a symlink")
    # work_id has already been reduced to a canonical UUID. Keep this comparison
    # lexical so concurrent creation of p cannot change resolve() semantics.
    target = p_root / work_id
    if target.parent != p_root:
        raise PublisherError("unsafe_target", "resolved output escaped the p directory")
    return p_root, target


def _load_and_verify_state(target: Path, expected_work_id: str) -> dict[str, object]:
    if target.is_symlink():
        raise PublisherError(
            "unmanaged_target",
            "prototype target must not be a symlink",
            exit_code=3,
        )
    state_path = target / STATE_NAME
    if state_path.is_symlink() or not state_path.is_file():
        raise PublisherError(
            "unmanaged_target",
            "target exists without a regular publisher state file",
            exit_code=3,
        )
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublisherError(
            "invalid_existing_state",
            "target publisher state is unreadable",
            exit_code=4,
        ) from exc

    if not isinstance(state, dict):
        raise PublisherError(
            "invalid_existing_state",
            "target publisher state must be an object",
            exit_code=4,
        )
    required = {
        "schema_version": SCHEMA_VERSION,
        "work_id": expected_work_id,
        "route": f"/p/{expected_work_id}/",
    }
    for field, expected in required.items():
        if state.get(field) != expected:
            raise PublisherError(
                "invalid_existing_state",
                f"target publisher state has an unexpected {field}",
                exit_code=4,
            )
    if not isinstance(state.get("content_digest"), str) or not DIGEST_RE.fullmatch(
        str(state["content_digest"])
    ):
        raise PublisherError(
            "invalid_existing_state",
            "target publisher state has an invalid content digest",
            exit_code=4,
        )

    actual_files: list[tuple[str, bytes]] = []
    for path in sorted(target.rglob("*"), key=lambda p: p.relative_to(target).as_posix()):
        relative_path = path.relative_to(target).as_posix()
        _validate_relative_path(relative_path)
        if path.is_symlink():
            raise PublisherError(
                "artifact_drift",
                f"published target contains a symlink: {relative_path}",
                exit_code=4,
            )
        if path.is_dir() or relative_path == STATE_NAME:
            continue
        if not path.is_file():
            raise PublisherError(
                "artifact_drift",
                f"published target contains a non-regular file: {relative_path}",
                exit_code=4,
            )
        actual_files.append((relative_path, path.read_bytes()))

    actual_digest = _digest_entries(ARTIFACT_DOMAIN, actual_files)
    if actual_digest != state.get("artifact_digest"):
        raise PublisherError(
            "artifact_drift",
            "published target files do not match publisher state",
            exit_code=4,
            details={
                "recorded": str(state.get("artifact_digest", "")),
                "actual": actual_digest,
            },
        )

    recorded_files = state.get("files")
    actual_file_state = [
        {
            "path": relative_path,
            "sha256": hashlib.sha256(content).hexdigest(),
            "size": len(content),
        }
        for relative_path, content in actual_files
    ]
    if recorded_files != actual_file_state:
        raise PublisherError(
            "artifact_drift",
            "published target file inventory does not match publisher state",
            exit_code=4,
        )
    return state


def _existing_result(
    target: Path,
    work_id: str,
    content_digest: str,
) -> dict[str, str]:
    state = _load_and_verify_state(target, work_id)
    recorded_digest = str(state["content_digest"])
    if recorded_digest != content_digest:
        raise PublisherError(
            "content_conflict",
            "work-id is already bound to different content",
            exit_code=3,
            details={
                "work_id": work_id,
                "recorded_content_digest": recorded_digest,
                "requested_content_digest": content_digest,
            },
        )
    return {
        "content_digest": content_digest,
        "route": f"/p/{work_id}/",
        "status": "unchanged",
        "work_id": work_id,
    }


def publish(
    site_root: str | Path,
    source: str | Path,
    work_id: str,
    expected_content_digest: str,
) -> dict[str, str]:
    work_id = _validate_work_id(work_id)
    expected_content_digest = _validate_expected_digest(expected_content_digest)
    bundle = read_bundle(source)
    if bundle.content_digest != expected_content_digest:
        raise PublisherError(
            "content_digest_mismatch",
            "source bytes do not match the requested content digest",
            exit_code=3,
            details={
                "computed_content_digest": bundle.content_digest,
                "requested_content_digest": expected_content_digest,
            },
        )

    p_root, target = _safe_target(site_root, work_id)
    if target.exists():
        return _existing_result(target, work_id, bundle.content_digest)

    p_root.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{work_id}.", dir=p_root))
    artifact_files = _artifact_files(bundle, work_id)
    state = _state_payload(work_id, bundle.content_digest, artifact_files)
    try:
        for relative_path, content in artifact_files:
            destination = stage / Path(relative_path)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        (stage / STATE_NAME).write_text(
            json.dumps(state, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        try:
            os.rename(stage, target)
        except OSError:
            if target.exists():
                return _existing_result(target, work_id, bundle.content_digest)
            raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)

    return {
        "content_digest": bundle.content_digest,
        "route": f"/p/{work_id}/",
        "status": "created",
        "work_id": work_id,
    }


def verify(
    site_root: str | Path,
    work_id: str,
    expected_content_digest: str,
) -> dict[str, str]:
    work_id = _validate_work_id(work_id)
    expected_content_digest = _validate_expected_digest(expected_content_digest)
    _, target = _safe_target(site_root, work_id)
    if not target.exists():
        raise PublisherError("missing_target", "prototype target does not exist", exit_code=3)
    state = _load_and_verify_state(target, work_id)
    recorded_digest = str(state["content_digest"])
    if recorded_digest != expected_content_digest:
        raise PublisherError(
            "content_conflict",
            "prototype exists with a different content digest",
            exit_code=3,
            details={
                "recorded_content_digest": recorded_digest,
                "requested_content_digest": expected_content_digest,
            },
        )
    return {
        "content_digest": recorded_digest,
        "route": f"/p/{work_id}/",
        "status": "verified",
        "work_id": work_id,
    }


def remove(
    site_root: str | Path,
    work_id: str,
    expected_content_digest: str,
) -> dict[str, str]:
    work_id = _validate_work_id(work_id)
    expected_content_digest = _validate_expected_digest(expected_content_digest)
    p_root, target = _safe_target(site_root, work_id)
    if not target.exists():
        return {
            "content_digest": expected_content_digest,
            "route": f"/p/{work_id}/",
            "status": "absent",
            "work_id": work_id,
        }

    state = _load_and_verify_state(target, work_id)
    recorded_digest = str(state["content_digest"])
    if recorded_digest != expected_content_digest:
        raise PublisherError(
            "content_conflict",
            "refusing to remove content with a different recorded digest",
            exit_code=3,
            details={
                "recorded_content_digest": recorded_digest,
                "requested_content_digest": expected_content_digest,
            },
        )

    tombstone = p_root / f".{work_id}.removed.{uuid.uuid4().hex}"
    os.rename(target, tombstone)
    shutil.rmtree(tombstone)
    try:
        p_root.rmdir()
    except OSError:
        pass
    return {
        "content_digest": recorded_digest,
        "route": f"/p/{work_id}/",
        "status": "removed",
        "work_id": work_id,
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Publish deterministic, unlisted prototypes below /p/<work-id>/",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("new-id", help="generate a canonical opaque UUIDv4 work-id")

    digest_parser = subparsers.add_parser(
        "digest", help="validate a source bundle and calculate its content digest"
    )
    digest_parser.add_argument("--source", required=True)

    for name in ("publish", "verify", "remove"):
        command_parser = subparsers.add_parser(name)
        command_parser.add_argument("--site-root", default=".")
        command_parser.add_argument("--work-id", required=True)
        command_parser.add_argument("--content-digest", required=True)
        if name == "publish":
            command_parser.add_argument("--source", required=True)
    return parser


def _write_json(payload: dict[str, object], stream: object = sys.stdout) -> None:
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")), file=stream)


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "new-id":
            _write_json({"status": "generated", "work_id": str(uuid.uuid4())})
        elif args.command == "digest":
            bundle = read_bundle(args.source)
            _write_json(
                {
                    "content_digest": bundle.content_digest,
                    "file_count": len(bundle.files),
                    "status": "validated",
                }
            )
        elif args.command == "publish":
            _write_json(
                publish(
                    args.site_root,
                    args.source,
                    args.work_id,
                    args.content_digest,
                )
            )
        elif args.command == "verify":
            _write_json(verify(args.site_root, args.work_id, args.content_digest))
        elif args.command == "remove":
            _write_json(remove(args.site_root, args.work_id, args.content_digest))
        else:  # pragma: no cover - argparse makes this unreachable
            parser.error("unknown command")
    except PublisherError as exc:
        payload: dict[str, object] = {
            "error": exc.kind,
            "message": str(exc),
            "status": "failed",
        }
        payload.update(exc.details)
        _write_json(payload, sys.stderr)
        return exc.exit_code
    except OSError as exc:
        _write_json(
            {
                "error": "filesystem_error",
                "message": str(exc),
                "status": "failed",
            },
            sys.stderr,
        )
        return 5
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
