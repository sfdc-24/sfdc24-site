#!/usr/bin/env python3
"""Deterministic, fail-closed publisher for unlisted GitHub Pages prototypes."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import uuid
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable


SCHEMA_VERSION = "blackboard.prototype.v1"
STATE_NAME = "prototype.json"
REMOVAL_DIR_NAME = ".prototype-removals"
REMOVAL_SCHEMA_VERSION = "blackboard.prototype.removal.v1"
LOCK_ROOT_PREFIX = "blackboard-prototype-publisher-locks-v2"
CONTENT_DOMAIN = b"blackboard.prototype.content.v1\0"
ARTIFACT_DOMAIN = b"blackboard.prototype.artifact.v1\0"
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
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
    def __init__(self, html_text: str) -> None:
        super().__init__(convert_charrefs=True)
        self._line_offsets = [0]
        for match in re.finditer("\n", html_text):
            self._line_offsets.append(match.end())
        self.head_count = 0
        self.head_close_count = 0
        self.head_insert_at: int | None = None
        self.in_head = False
        self.body_started = False
        self.template_depth = 0
        self.structure_errors: list[str] = []
        self.robots: list[str] = []
        self.viewports: list[str] = []
        self.reserved: list[str] = []
        self.metadata_outside_head: list[str] = []
        self.ambiguous_meta_attributes: list[str] = []

    def _absolute_position(self) -> int:
        line, offset = self.getpos()
        return self._line_offsets[line - 1] + offset

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "template":
            self.template_depth += 1
            return
        if tag == "head":
            if self.template_depth:
                return
            self.head_count += 1
            if self.body_started:
                self.structure_errors.append("head_after_body")
            if self.in_head:
                self.structure_errors.append("nested_head")
            self.in_head = True
            raw_tag = self.get_starttag_text() or ""
            if self.head_count == 1:
                self.head_insert_at = self._absolute_position() + len(raw_tag)
            return
        if tag == "body" and not self.template_depth:
            if self.in_head:
                self.structure_errors.append("body_before_head_close")
            self.body_started = True
        if tag != "meta":
            return
        attribute_names = [str(key).lower() for key, _ in attrs]
        for attribute_name in ("name", "content"):
            if attribute_names.count(attribute_name) > 1:
                self.ambiguous_meta_attributes.append(attribute_name)
        values = {str(key).lower(): (value or "") for key, value in attrs}
        name = values.get("name", "").strip().lower()
        content = values.get("content", "").strip()
        if name in RESERVED_META_NAMES:
            self.reserved.append(name)
        if not self.in_head or self.template_depth:
            if name in {"robots", "viewport"}:
                self.metadata_outside_head.append(name)
            return
        if name == "robots":
            self.robots.append(content)
        elif name == "viewport":
            self.viewports.append(content)

    def handle_startendtag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        if tag.lower() == "head" and not self.template_depth:
            self.structure_errors.append("self_closing_head")
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "template":
            if self.template_depth:
                self.template_depth -= 1
            return
        if tag != "head" or self.template_depth:
            return
        self.head_close_count += 1
        if not self.in_head:
            self.structure_errors.append("unmatched_head_close")
        self.in_head = False


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
            "content-digest must be sha256: followed by 64 lowercase hex characters",
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

    scanner = _HeadMetadata(html_text)
    scanner.feed(html_text)
    scanner.close()
    if (
        scanner.head_count != 1
        or scanner.head_close_count != 1
        or scanner.head_insert_at is None
        or scanner.in_head
        or scanner.structure_errors
    ):
        raise PublisherError(
            "invalid_html_structure",
            f"HTML must contain exactly one explicit, closed head before body: {relative_path}",
            details={"path": relative_path},
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
    if scanner.ambiguous_meta_attributes:
        raise PublisherError(
            "ambiguous_metadata_attributes",
            "meta tags must not repeat name or content attributes",
            details={
                "attributes": ",".join(
                    sorted(set(scanner.ambiguous_meta_attributes))
                ),
                "path": relative_path,
            },
        )
    if scanner.metadata_outside_head:
        raise PublisherError(
            "metadata_outside_head",
            "robots and viewport metadata are allowed only in the one real head",
            details={
                "meta": ",".join(sorted(set(scanner.metadata_outside_head))),
                "path": relative_path,
            },
        )

    if len(scanner.robots) > 1:
        raise PublisherError(
            "duplicate_robots_metadata",
            f"HTML head must contain at most one robots meta tag: {relative_path}",
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

    if len(scanner.viewports) > 1:
        raise PublisherError(
            "duplicate_viewport_metadata",
            f"HTML head must contain at most one viewport meta tag: {relative_path}",
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
        if Path(relative_path).name.lower() == STATE_NAME:
            raise PublisherError(
                "reserved_source_path",
                f"the basename {STATE_NAME} is reserved at every source level",
                details={"path": relative_path},
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
    if scanner.head_insert_at is None:  # guarded in _scan_html
        raise PublisherError(
            "invalid_html_structure",
            f"HTML must contain exactly one explicit, closed head: {relative_path}",
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
    rendered = (
        html_text[: scanner.head_insert_at]
        + insertion
        + html_text[scanner.head_insert_at :]
    )
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


def _path_present(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def _removal_paths(p_root: Path, work_id: str) -> tuple[Path, Path, Path]:
    removal_root = p_root / REMOVAL_DIR_NAME
    if removal_root.is_symlink():
        raise PublisherError(
            "unsafe_removal_state",
            "the prototype removal-state directory must not be a symlink",
            exit_code=4,
        )
    journal = removal_root / f"{work_id}.json"
    tombstone = removal_root / work_id
    return removal_root, journal, tombstone


def _is_reparse_or_symlink(info: os.stat_result) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    file_attributes = getattr(info, "st_file_attributes", 0)
    return stat.S_ISLNK(info.st_mode) or bool(
        reparse_flag and file_attributes & reparse_flag
    )


def _unsafe_lock(
    message: str,
    component: str,
    *,
    cause: OSError | None = None,
) -> PublisherError:
    error = PublisherError(
        "unsafe_removal_lock",
        message,
        exit_code=4,
        details={"lock_component": component},
    )
    if cause is not None:
        error.__cause__ = cause
    return error


def _private_lock_paths(p_root: Path, work_id: str) -> tuple[Path, Path, Path]:
    try:
        temp_root = Path(tempfile.gettempdir()).resolve(strict=True)
    except OSError as exc:
        raise _unsafe_lock(
            "the operating-system temporary directory could not be resolved",
            "temp_root",
            cause=exc,
        )
    if not temp_root.is_dir():
        raise _unsafe_lock(
            "the operating-system temporary path is not a directory",
            "temp_root",
        )

    if os.name == "nt":
        user_key = hashlib.sha256(
            os.path.normcase(str(temp_root)).encode("utf-8")
        ).hexdigest()[:16]
    else:
        try:
            user_key = f"uid-{os.geteuid()}"
        except AttributeError as exc:  # pragma: no cover - supported targets expose it
            raise _unsafe_lock(
                "the current POSIX user identity could not be established",
                "lock_root",
            ) from exc

    lock_root = temp_root / f"{LOCK_ROOT_PREFIX}-{user_key}"
    site_key = hashlib.sha256(
        os.path.normcase(str(p_root.parent.resolve())).encode("utf-8")
    ).hexdigest()[:24]
    site_lock_root = lock_root / site_key
    return lock_root, site_lock_root, site_lock_root / f"{work_id}.lock"


def _validate_private_lock_directory(path: Path, component: str) -> None:
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    except OSError as exc:
        raise _unsafe_lock(
            "a private removal-lock directory could not be created",
            component,
            cause=exc,
        )

    try:
        info = os.lstat(path)
    except OSError as exc:
        raise _unsafe_lock(
            "a removal-lock directory could not be inspected",
            component,
            cause=exc,
        )
    if _is_reparse_or_symlink(info) or not stat.S_ISDIR(info.st_mode):
        raise _unsafe_lock(
            "a removal-lock path component is not a real directory",
            component,
        )
    if os.name != "nt":
        try:
            current_uid = os.geteuid()
        except AttributeError as exc:  # pragma: no cover - supported targets expose it
            raise _unsafe_lock(
                "the current POSIX user identity could not be established",
                component,
            ) from exc
        if info.st_uid != current_uid:
            raise _unsafe_lock(
                "a removal-lock directory is not owned by the current user",
                component,
            )
        if stat.S_IMODE(info.st_mode) & 0o077:
            raise _unsafe_lock(
                "a removal-lock directory is accessible by group or other users",
                component,
            )


def _validate_lock_file_info(info: os.stat_result, component: str) -> None:
    if _is_reparse_or_symlink(info) or not stat.S_ISREG(info.st_mode):
        raise _unsafe_lock(
            "the removal-lock file is not a real regular file",
            component,
        )
    if info.st_nlink != 1:
        raise _unsafe_lock(
            "the removal-lock file has an unsafe hard-link count",
            component,
        )
    if os.name != "nt":
        try:
            current_uid = os.geteuid()
        except AttributeError as exc:  # pragma: no cover - supported targets expose it
            raise _unsafe_lock(
                "the current POSIX user identity could not be established",
                component,
            ) from exc
        if info.st_uid != current_uid:
            raise _unsafe_lock(
                "the removal-lock file is not owned by the current user",
                component,
            )
        if stat.S_IMODE(info.st_mode) & 0o077:
            raise _unsafe_lock(
                "the removal-lock file is accessible by group or other users",
                component,
            )


def _open_private_lock_file(lock_path: Path):
    if _path_present(lock_path):
        try:
            _validate_lock_file_info(os.lstat(lock_path), "lock_file")
        except OSError as exc:
            raise _unsafe_lock(
                "the removal-lock file could not be inspected",
                "lock_file",
                cause=exc,
            )

    flags = os.O_CREAT | os.O_RDWR
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOINHERIT", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(lock_path, flags, 0o600)
    except OSError as exc:
        raise _unsafe_lock(
            "the removal-lock file could not be opened without following links",
            "lock_file",
            cause=exc,
        )

    try:
        descriptor_info = os.fstat(descriptor)
        path_info = os.lstat(lock_path)
        _validate_lock_file_info(descriptor_info, "lock_file")
        _validate_lock_file_info(path_info, "lock_file")
        if (descriptor_info.st_dev, descriptor_info.st_ino) != (
            path_info.st_dev,
            path_info.st_ino,
        ):
            raise _unsafe_lock(
                "the removal-lock path changed while it was being opened",
                "lock_file",
            )
        return os.fdopen(descriptor, "r+b", buffering=0)
    except BaseException:
        os.close(descriptor)
        raise


@contextlib.contextmanager
def _removal_lock(p_root: Path, work_id: str):
    lock_root, site_lock_root, lock_path = _private_lock_paths(p_root, work_id)
    _validate_private_lock_directory(lock_root, "lock_root")
    _validate_private_lock_directory(site_lock_root, "site_lock_root")
    # Re-read the parent after creating its child so a component replacement
    # cannot silently redirect the final safe-open operation.
    _validate_private_lock_directory(lock_root, "lock_root")
    stream = _open_private_lock_file(lock_path)
    locked = False
    try:
        if os.fstat(stream.fileno()).st_size == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except OSError as exc:
            raise PublisherError(
                "removal_in_progress",
                "another process owns the work-id removal lock",
                exit_code=4,
                details={"recovery_state": "active_lock_preserved"},
            ) from exc
        yield
    finally:
        if locked:
            try:
                stream.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        stream.close()


def _removal_payload(
    work_id: str, content_digest: str, status: str
) -> dict[str, str]:
    return {
        "content_digest": content_digest,
        "route": f"/p/{work_id}/",
        "schema_version": REMOVAL_SCHEMA_VERSION,
        "status": status,
        "work_id": work_id,
    }


def _write_removal_journal(
    journal: Path,
    payload: dict[str, str],
    *,
    exclusive: bool = False,
) -> None:
    journal.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if exclusive:
        with journal.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(serialized)
        return

    temporary = journal.with_name(f".{journal.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(serialized)
        os.replace(temporary, journal)
    finally:
        if _path_present(temporary):
            temporary.unlink()


def _read_removal_journal(
    journal: Path,
    work_id: str,
    expected_content_digest: str,
) -> dict[str, str]:
    if journal.is_symlink() or not journal.is_file():
        raise PublisherError(
            "invalid_removal_state",
            "prototype removal journal is missing or is not a regular file",
            exit_code=4,
        )
    try:
        raw = json.loads(journal.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublisherError(
            "invalid_removal_state",
            "prototype removal journal is unreadable",
            exit_code=4,
        ) from exc
    if not isinstance(raw, dict):
        raise PublisherError(
            "invalid_removal_state",
            "prototype removal journal must be an object",
            exit_code=4,
        )
    required = {
        "content_digest": expected_content_digest,
        "route": f"/p/{work_id}/",
        "schema_version": REMOVAL_SCHEMA_VERSION,
        "work_id": work_id,
    }
    for field, expected in required.items():
        if raw.get(field) != expected:
            details = {"field": field}
            if field == "content_digest":
                details.update(
                    {
                        "recorded_content_digest": str(raw.get(field, "")),
                        "requested_content_digest": expected_content_digest,
                    }
                )
            raise PublisherError(
                "removal_state_conflict",
                f"prototype removal journal has an unexpected {field}",
                exit_code=4,
                details=details,
            )
    status = raw.get("status")
    if status not in {"deleting", "quarantined", "deleted"}:
        raise PublisherError(
            "invalid_removal_state",
            "prototype removal journal has an invalid status",
            exit_code=4,
        )
    return {str(key): str(value) for key, value in raw.items()}


def _cleanup_empty_removal_directories(removal_root: Path, p_root: Path) -> None:
    for directory in (removal_root, p_root):
        try:
            directory.rmdir()
        except OSError:
            pass


def _clear_removal_journal(journal: Path, removal_root: Path, p_root: Path) -> None:
    try:
        journal.unlink()
    except OSError as exc:
        raise PublisherError(
            "removal_metadata_cleanup_failed",
            "prototype bytes were removed but the removal journal could not be cleared",
            exit_code=5,
            details={"recovery_state": "deleted_journal_preserved"},
        ) from exc
    _cleanup_empty_removal_directories(removal_root, p_root)


def _raise_after_failed_removal(
    *,
    failure_kind: str,
    failure: Exception,
    p_root: Path,
    target: Path,
    removal_root: Path,
    journal: Path,
    tombstone: Path,
    work_id: str,
    content_digest: str,
) -> None:
    journal_update = "quarantined"
    try:
        _write_removal_journal(
            journal,
            _removal_payload(work_id, content_digest, "quarantined"),
        )
    except OSError:
        # The original journal remains discoverable and blocks an "absent"
        # response even when its status could not be advanced.
        journal_update = "original_journal_preserved"

    restored = False
    restore_error = ""
    safe_to_restore = _path_present(tombstone)
    tombstone_validation_error = ""
    if failure_kind == "removal_delete_failed" and safe_to_restore:
        try:
            state = _load_and_verify_state(tombstone, work_id)
            safe_to_restore = state.get("content_digest") == content_digest
            if not safe_to_restore:
                tombstone_validation_error = "content_digest_mismatch"
        except PublisherError as exc:
            safe_to_restore = False
            tombstone_validation_error = exc.kind

    if not _path_present(target) and safe_to_restore:
        try:
            os.rename(tombstone, target)
            restored = True
        except OSError as exc:
            restore_error = exc.__class__.__name__

    if restored:
        try:
            _clear_removal_journal(journal, removal_root, p_root)
            journal_update = "cleared"
        except PublisherError:
            journal_update = "journal_preserved"
        raise PublisherError(
            f"{failure_kind}_restored",
            "prototype removal failed; the original route was atomically restored",
            exit_code=5,
            details={
                "cause": failure.__class__.__name__,
                "cause_error": (
                    failure.kind if isinstance(failure, PublisherError) else failure_kind
                ),
                "journal_state": journal_update,
                "recovery_state": "target_restored",
            },
        ) from failure

    recovery_state = (
        "target_collision_tombstone_preserved"
        if _path_present(target) and _path_present(tombstone)
        else "tombstone_and_journal_preserved"
        if _path_present(tombstone)
        else "journal_preserved_state_unknown"
    )
    details = {
        "cause": failure.__class__.__name__,
        "cause_error": (
            failure.kind if isinstance(failure, PublisherError) else failure_kind
        ),
        "journal_state": journal_update,
        "recovery_state": recovery_state,
    }
    if restore_error:
        details["restore_error"] = restore_error
    if tombstone_validation_error:
        details["tombstone_validation_error"] = tombstone_validation_error
    raise PublisherError(
        f"{failure_kind}_quarantined",
        "prototype removal failed and recoverable state was quarantined",
        exit_code=5,
        details=details,
    ) from failure


def _delete_tombstone(
    *,
    p_root: Path,
    target: Path,
    removal_root: Path,
    journal: Path,
    tombstone: Path,
    work_id: str,
    content_digest: str,
) -> dict[str, str]:
    try:
        shutil.rmtree(tombstone)
    except OSError as exc:
        _raise_after_failed_removal(
            failure_kind="removal_delete_failed",
            failure=exc,
            p_root=p_root,
            target=target,
            removal_root=removal_root,
            journal=journal,
            tombstone=tombstone,
            work_id=work_id,
            content_digest=content_digest,
        )

    try:
        _write_removal_journal(
            journal,
            _removal_payload(work_id, content_digest, "deleted"),
        )
    except OSError as exc:
        raise PublisherError(
            "removal_metadata_update_failed",
            "prototype bytes were removed but durable removal state could not be updated",
            exit_code=5,
            details={"recovery_state": "original_journal_preserved"},
        ) from exc
    _clear_removal_journal(journal, removal_root, p_root)
    return {
        "content_digest": content_digest,
        "route": f"/p/{work_id}/",
        "status": "removed",
        "work_id": work_id,
    }


def _guard_no_incomplete_removal(p_root: Path, work_id: str) -> None:
    _, journal, tombstone = _removal_paths(p_root, work_id)
    if _path_present(journal) or _path_present(tombstone):
        raise PublisherError(
            "removal_incomplete",
            "prototype has discoverable incomplete removal state",
            exit_code=4,
            details={"work_id": work_id},
        )


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
    _guard_no_incomplete_removal(p_root, work_id)
    if _path_present(target):
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
            _guard_no_incomplete_removal(p_root, work_id)
            if _path_present(target):
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
    p_root, target = _safe_target(site_root, work_id)
    _guard_no_incomplete_removal(p_root, work_id)
    if not _path_present(target):
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
    with _removal_lock(p_root, work_id):
        return _remove_locked(
            p_root, target, work_id, expected_content_digest
        )


def _remove_locked(
    p_root: Path,
    target: Path,
    work_id: str,
    expected_content_digest: str,
) -> dict[str, str]:
    removal_root, journal, tombstone = _removal_paths(p_root, work_id)

    if _path_present(journal):
        removal_state = _read_removal_journal(
            journal, work_id, expected_content_digest
        )
        status = removal_state["status"]
        target_present = _path_present(target)
        tombstone_present = _path_present(tombstone)

        if status == "deleted":
            if target_present or tombstone_present:
                raise PublisherError(
                    "invalid_removal_state",
                    "deleted removal state conflicts with files still on disk",
                    exit_code=4,
                )
            _clear_removal_journal(journal, removal_root, p_root)
            return {
                "content_digest": expected_content_digest,
                "route": f"/p/{work_id}/",
                "status": "removed",
                "work_id": work_id,
            }

        if target_present and tombstone_present:
            raise PublisherError(
                "removal_recovery_collision",
                "both the public target and quarantined tombstone exist",
                exit_code=4,
                details={
                    "recovery_state": "target_collision_tombstone_preserved",
                    "work_id": work_id,
                },
            )
        if target_present:
            # A prior rollback restored the public target but could not clear its
            # journal. Verify the restored bytes before releasing the guard.
            state = _load_and_verify_state(target, work_id)
            if state.get("content_digest") != expected_content_digest:
                raise PublisherError(
                    "removal_state_conflict",
                    "restored target digest conflicts with its removal journal",
                    exit_code=4,
                )
            _clear_removal_journal(journal, removal_root, p_root)
            removal_root, journal, tombstone = _removal_paths(p_root, work_id)
        elif tombstone_present:
            state = _load_and_verify_state(tombstone, work_id)
            if state.get("content_digest") != expected_content_digest:
                raise PublisherError(
                    "removal_state_conflict",
                    "quarantined tombstone digest conflicts with its removal journal",
                    exit_code=4,
                )
            _write_removal_journal(
                journal,
                _removal_payload(work_id, expected_content_digest, "deleting"),
            )
            return _delete_tombstone(
                p_root=p_root,
                target=target,
                removal_root=removal_root,
                journal=journal,
                tombstone=tombstone,
                work_id=work_id,
                content_digest=expected_content_digest,
            )
        else:
            # The only publisher transition that can leave a valid journal with
            # neither directory present is a crash after tombstone deletion and
            # before the journal was advanced. The per-work-ID OS lock proves no
            # remover is still active, so finish the desired state as `removed`
            # (never `absent`) and make the next identical retry the no-op.
            _write_removal_journal(
                journal,
                _removal_payload(work_id, expected_content_digest, "deleted"),
            )
            _clear_removal_journal(journal, removal_root, p_root)
            return {
                "content_digest": expected_content_digest,
                "route": f"/p/{work_id}/",
                "status": "removed",
                "work_id": work_id,
            }
    elif _path_present(tombstone):
        raise PublisherError(
            "orphaned_removal_tombstone",
            "a removal tombstone exists without its journal",
            exit_code=5,
            details={"recovery_state": "tombstone_preserved"},
        )

    if not _path_present(target):
        return {
            "content_digest": expected_content_digest,
            "route": f"/p/{work_id}/",
            "status": "absent",
            "work_id": work_id,
        }

    removal_root.mkdir(parents=True, exist_ok=True)
    try:
        _write_removal_journal(
            journal,
            _removal_payload(work_id, expected_content_digest, "deleting"),
            exclusive=True,
        )
    except FileExistsError as exc:
        raise PublisherError(
            "removal_in_progress",
            "another removal owns the work-id journal",
            exit_code=4,
            details={"recovery_state": "journal_preserved"},
        ) from exc

    try:
        os.rename(target, tombstone)
    except OSError as exc:
        if not _path_present(tombstone):
            try:
                _clear_removal_journal(journal, removal_root, p_root)
            except PublisherError:
                pass
        raise PublisherError(
            "removal_move_failed",
            "prototype could not be moved into durable removal state",
            exit_code=5,
            details={"recovery_state": "target_preserved"},
        ) from exc

    # Verify after the atomic move. This is the authoritative check on the exact
    # directory that would be deleted and closes the verify-then-rename race.
    try:
        state = _load_and_verify_state(tombstone, work_id)
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
    except PublisherError as exc:
        _raise_after_failed_removal(
            failure_kind="removal_verification_failed",
            failure=exc,
            p_root=p_root,
            target=target,
            removal_root=removal_root,
            journal=journal,
            tombstone=tombstone,
            work_id=work_id,
            content_digest=expected_content_digest,
        )

    return _delete_tombstone(
        p_root=p_root,
        target=target,
        removal_root=removal_root,
        journal=journal,
        tombstone=tombstone,
        work_id=work_id,
        content_digest=recorded_digest,
    )


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
