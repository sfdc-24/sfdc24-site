from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "tools" / "prototype_publisher.py"
SPEC = importlib.util.spec_from_file_location("prototype_publisher", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
publisher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = publisher
SPEC.loader.exec_module(publisher)


def tree_fingerprint(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda p: p.relative_to(root).as_posix()):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix().encode("utf-8")
        content = path.read_bytes()
        digest.update(relative)
        digest.update(b"\0")
        digest.update(str(len(content)).encode("ascii"))
        digest.update(b"\0")
        digest.update(content)
    return digest.hexdigest()


class PrototypePublisherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.site = self.base / "site"
        self.site.mkdir()
        (self.site / "index.html").write_text("HOME\n", encoding="utf-8")
        (self.site / "governor").mkdir()
        (self.site / "governor" / "index.html").write_text(
            "GOVERNOR\n", encoding="utf-8"
        )
        self.home_before = (self.site / "index.html").read_bytes()
        self.governor_before = (self.site / "governor" / "index.html").read_bytes()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def make_source(
        self,
        name: str,
        body: str = "Prototype",
        *,
        head_extra: str = "",
    ) -> Path:
        source = self.base / name
        source.mkdir()
        (source / "index.html").write_text(
            "<!doctype html>\n"
            '<html lang="en"><head><meta charset="utf-8">'
            f"{head_extra}<title>{body}</title></head>"
            f"<body><main><h1>{body}</h1></main></body></html>\n",
            encoding="utf-8",
            newline="\n",
        )
        (source / "assets").mkdir()
        (source / "assets" / "site.css").write_text(
            "body{margin:0}main{max-width:48rem;margin:auto;padding:1rem}"
            "img{max-width:100%;height:auto}\n",
            encoding="utf-8",
            newline="\n",
        )
        (source / "details").mkdir()
        (source / "details" / "index.html").write_text(
            "<!doctype html><html><head><title>Details</title></head>"
            "<body><main>Details</main></body></html>\n",
            encoding="utf-8",
            newline="\n",
        )
        return source

    def publish_source(self, source: Path, work_id: str | None = None):
        work_id = work_id or str(uuid.uuid4())
        bundle = publisher.read_bundle(source)
        result = publisher.publish(
            self.site, source, work_id, bundle.content_digest
        )
        return work_id, bundle, result

    def assert_protected_surfaces_unchanged(self) -> None:
        self.assertEqual(self.home_before, (self.site / "index.html").read_bytes())
        self.assertEqual(
            self.governor_before,
            (self.site / "governor" / "index.html").read_bytes(),
        )

    def test_publish_injects_noindex_viewport_and_readback_markers(self) -> None:
        source = self.make_source("source")
        work_id, bundle, result = self.publish_source(source)

        self.assertEqual("created", result["status"])
        target = self.site / "p" / work_id
        for page in (target / "index.html", target / "details" / "index.html"):
            html = page.read_text(encoding="utf-8")
            self.assertIn('name="robots" content="noindex, nofollow"', html)
            self.assertIn(
                'name="viewport" content="width=device-width, initial-scale=1"',
                html,
            )
            self.assertIn(f'name="blackboard-work-id" content="{work_id}"', html)
            self.assertIn(
                f'name="blackboard-content-digest" content="{bundle.content_digest}"',
                html,
            )

        state = json.loads((target / "prototype.json").read_text(encoding="utf-8"))
        self.assertEqual(publisher.SCHEMA_VERSION, state["schema_version"])
        self.assertEqual(work_id, state["work_id"])
        self.assertEqual(bundle.content_digest, state["content_digest"])
        self.assertEqual(f"/p/{work_id}/", state["route"])
        self.assertEqual(
            "verified",
            publisher.verify(
                self.site, work_id, bundle.content_digest
            )["status"],
        )
        self.assert_protected_surfaces_unchanged()

    def test_identical_retry_is_a_byte_preserving_no_op(self) -> None:
        source = self.make_source("source")
        work_id, bundle, first = self.publish_source(source)
        before = tree_fingerprint(self.site / "p" / work_id)
        second = publisher.publish(
            self.site, source, work_id, bundle.content_digest
        )

        self.assertEqual("created", first["status"])
        self.assertEqual("unchanged", second["status"])
        self.assertEqual(before, tree_fingerprint(self.site / "p" / work_id))
        self.assert_protected_surfaces_unchanged()

    def test_conflicting_retry_fails_closed_without_mutation(self) -> None:
        first_source = self.make_source("first", "First")
        second_source = self.make_source("second", "Second")
        work_id, _, _ = self.publish_source(first_source)
        before = tree_fingerprint(self.site)
        second_bundle = publisher.read_bundle(second_source)

        with self.assertRaises(publisher.PublisherError) as caught:
            publisher.publish(
                self.site, second_source, work_id, second_bundle.content_digest
            )

        self.assertEqual("content_conflict", caught.exception.kind)
        self.assertEqual(3, caught.exception.exit_code)
        self.assertEqual(before, tree_fingerprint(self.site))

    def test_requested_digest_mismatch_creates_nothing(self) -> None:
        source = self.make_source("source")
        work_id = str(uuid.uuid4())
        wrong_digest = "sha256:" + ("0" * 64)

        with self.assertRaises(publisher.PublisherError) as caught:
            publisher.publish(self.site, source, work_id, wrong_digest)

        self.assertEqual("content_digest_mismatch", caught.exception.kind)
        self.assertFalse((self.site / "p" / work_id).exists())
        self.assert_protected_surfaces_unchanged()

    def test_concurrent_distinct_ids_are_isolated(self) -> None:
        entries = []
        for number in range(8):
            source = self.make_source(f"source-{number}", f"Prototype {number}")
            entries.append((str(uuid.uuid4()), source, publisher.read_bundle(source)))

        def create(entry):
            work_id, source, bundle = entry
            return publisher.publish(
                self.site, source, work_id, bundle.content_digest
            )

        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(create, entries))

        self.assertEqual(["created"] * 8, [result["status"] for result in results])
        for work_id, _, bundle in entries:
            verified = publisher.verify(self.site, work_id, bundle.content_digest)
            self.assertEqual("verified", verified["status"])
        self.assert_protected_surfaces_unchanged()

    def test_concurrent_conflicting_same_id_has_one_winner(self) -> None:
        first = self.make_source("first", "First")
        second = self.make_source("second", "Second")
        work_id = str(uuid.uuid4())
        entries = [(first, publisher.read_bundle(first)), (second, publisher.read_bundle(second))]

        def create(entry):
            source, bundle = entry
            try:
                return (
                    "result",
                    publisher.publish(
                        self.site, source, work_id, bundle.content_digest
                    ),
                )
            except publisher.PublisherError as exc:
                return ("error", exc)

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(create, entries))

        kinds = sorted(outcome[0] for outcome in outcomes)
        self.assertEqual(["error", "result"], kinds)
        error = next(outcome[1] for outcome in outcomes if outcome[0] == "error")
        self.assertEqual("content_conflict", error.kind)
        state = json.loads(
            (self.site / "p" / work_id / "prototype.json").read_text(encoding="utf-8")
        )
        self.assertIn(
            state["content_digest"],
            {entries[0][1].content_digest, entries[1][1].content_digest},
        )
        publisher.verify(self.site, work_id, state["content_digest"])
        self.assert_protected_surfaces_unchanged()

    def test_removal_is_digest_guarded_and_isolated(self) -> None:
        first = self.make_source("first", "First")
        second = self.make_source("second", "Second")
        first_id, first_bundle, _ = self.publish_source(first)
        second_id, second_bundle, _ = self.publish_source(second)
        second_before = tree_fingerprint(self.site / "p" / second_id)

        with self.assertRaises(publisher.PublisherError) as caught:
            publisher.remove(
                self.site, first_id, "sha256:" + ("f" * 64)
            )
        self.assertEqual(
            "removal_verification_failed_restored", caught.exception.kind
        )
        self.assertEqual("content_conflict", caught.exception.details["cause_error"])
        self.assertEqual("target_restored", caught.exception.details["recovery_state"])
        self.assertTrue((self.site / "p" / first_id).exists())

        removed = publisher.remove(self.site, first_id, first_bundle.content_digest)
        repeated = publisher.remove(self.site, first_id, first_bundle.content_digest)
        self.assertEqual("removed", removed["status"])
        self.assertEqual("absent", repeated["status"])
        self.assertFalse((self.site / "p" / first_id).exists())
        self.assertEqual(second_before, tree_fingerprint(self.site / "p" / second_id))
        publisher.verify(self.site, second_id, second_bundle.content_digest)
        self.assert_protected_surfaces_unchanged()

    def test_artifact_drift_blocks_retry_verify_and_removal(self) -> None:
        source = self.make_source("source")
        work_id, bundle, _ = self.publish_source(source)
        target_index = self.site / "p" / work_id / "index.html"
        target_index.write_text("tampered\n", encoding="utf-8")

        operations = (
            (
                lambda: publisher.publish(
                    self.site, source, work_id, bundle.content_digest
                ),
                "artifact_drift",
            ),
            (
                lambda: publisher.verify(
                    self.site, work_id, bundle.content_digest
                ),
                "artifact_drift",
            ),
            (
                lambda: publisher.remove(
                    self.site, work_id, bundle.content_digest
                ),
                "removal_verification_failed_restored",
            ),
        )
        for operation, expected_error in operations:
            with self.assertRaises(publisher.PublisherError) as caught:
                operation()
            self.assertEqual(expected_error, caught.exception.kind)
            if expected_error == "removal_verification_failed_restored":
                self.assertEqual(
                    "artifact_drift", caught.exception.details["cause_error"]
                )
                self.assertEqual(
                    "target_restored", caught.exception.details["recovery_state"]
                )
        self.assertTrue(target_index.exists())
        self.assert_protected_surfaces_unchanged()

    def test_existing_index_or_non_device_viewport_is_rejected(self) -> None:
        unsafe_robots = self.make_source(
            "robots", head_extra='<meta name="robots" content="index, follow">'
        )
        unsafe_viewport = self.make_source(
            "viewport", head_extra='<meta name="viewport" content="width=1024">'
        )

        with self.assertRaises(publisher.PublisherError) as robots_error:
            publisher.read_bundle(unsafe_robots)
        self.assertEqual("unsafe_robots_metadata", robots_error.exception.kind)

        with self.assertRaises(publisher.PublisherError) as viewport_error:
            publisher.read_bundle(unsafe_viewport)
        self.assertEqual("unsafe_viewport_metadata", viewport_error.exception.kind)

    def test_work_id_must_be_an_opaque_uuidv4(self) -> None:
        source = self.make_source("source")
        bundle = publisher.read_bundle(source)
        for invalid in ("customer-name", str(uuid.uuid1()), str(uuid.uuid4()).upper()):
            with self.subTest(invalid=invalid):
                with self.assertRaises(publisher.PublisherError) as caught:
                    publisher.publish(
                        self.site, source, invalid, bundle.content_digest
                    )
                self.assertEqual("invalid_work_id", caught.exception.kind)
        self.assert_protected_surfaces_unchanged()

    def test_repository_control_and_credential_prone_files_are_rejected(self) -> None:
        for forbidden in (".git", ".env.local", "private.pem"):
            with self.subTest(forbidden=forbidden):
                source = self.make_source(f"forbidden-{forbidden.replace('.', '-')}")
                (source / forbidden).write_text("must-not-publish\n", encoding="utf-8")
                with self.assertRaises(publisher.PublisherError) as caught:
                    publisher.read_bundle(source)
                self.assertEqual("forbidden_source_path", caught.exception.kind)

    def test_prototype_state_basename_is_reserved_at_every_level_case_safe(self) -> None:
        for relative_path in (
            Path("nested") / "prototype.json",
            Path("assets") / "Prototype.JSON",
        ):
            with self.subTest(relative_path=relative_path.as_posix()):
                source = self.make_source(f"reserved-{uuid.uuid4().hex}")
                destination = source / relative_path
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text("{}\n", encoding="utf-8")
                with self.assertRaises(publisher.PublisherError) as caught:
                    publisher.read_bundle(source)
                self.assertEqual("reserved_source_path", caught.exception.kind)
                self.assertEqual(
                    relative_path.as_posix(), caught.exception.details["path"]
                )

    def test_body_metadata_fails_closed_instead_of_contradicting_head(self) -> None:
        source = self.make_source("body-metadata")
        (source / "index.html").write_text(
            "<!doctype html><html><head><title>Real head</title></head><body>"
            '<meta name="robots" content="index, follow">'
            '<meta name="viewport" content="width=1024">'
            "<main>Body</main></body></html>\n",
            encoding="utf-8",
            newline="\n",
        )
        with self.assertRaises(publisher.PublisherError) as caught:
            publisher.read_bundle(source)
        self.assertEqual("metadata_outside_head", caught.exception.kind)
        self.assertEqual("robots,viewport", caught.exception.details["meta"])

    def test_comment_and_script_head_decoys_do_not_control_insertion(self) -> None:
        source = self.make_source("head-decoys")
        (source / "index.html").write_text(
            '<!doctype html><html><!-- <head id="comment-decoy"> -->'
            '<head id="real"><script>const decoy = "<head id=script-decoy>";'
            "</script><title>Real head</title></head><body>Body</body></html>\n",
            encoding="utf-8",
            newline="\n",
        )
        work_id, _, _ = self.publish_source(source)
        html = (self.site / "p" / work_id / "index.html").read_text(
            encoding="utf-8"
        )
        marker = html.index('name="blackboard-work-id"')
        self.assertGreater(marker, html.index('<head id="real">'))
        self.assertLess(marker, html.index("<script>"))
        self.assertEqual(1, html.count('name="blackboard-work-id"'))
        self.assertIn('<!-- <head id="comment-decoy"> -->', html)

    def test_duplicate_or_contradictory_head_metadata_is_rejected(self) -> None:
        cases = (
            (
                "duplicate-head",
                "<!doctype html><html><head></head><head></head>"
                "<body></body></html>",
                "invalid_html_structure",
            ),
            (
                "body-before-head-close",
                "<!doctype html><html><head><body>"
                '<meta name="viewport" content="width=device-width">'
                "</body></head></html>",
                "invalid_html_structure",
            ),
            (
                "duplicate-robots",
                "<!doctype html><html><head>"
                '<meta name="robots" content="noindex">'
                '<meta name="robots" content="noindex, nofollow">'
                "</head><body></body></html>",
                "duplicate_robots_metadata",
            ),
            (
                "duplicate-viewport",
                "<!doctype html><html><head>"
                '<meta name="viewport" content="width=device-width">'
                '<meta name="viewport" content="width=device-width, initial-scale=1">'
                "</head><body></body></html>",
                "duplicate_viewport_metadata",
            ),
            (
                "contradictory-robots",
                "<!doctype html><html><head>"
                '<meta name="robots" content="index, follow">'
                "</head><body></body></html>",
                "unsafe_robots_metadata",
            ),
            (
                "duplicate-name-attribute",
                "<!doctype html><html><head>"
                '<meta name="robots" name="description" content="index">'
                "</head><body></body></html>",
                "ambiguous_metadata_attributes",
            ),
        )
        for name, html, expected_error in cases:
            with self.subTest(name=name):
                source = self.make_source(name)
                (source / "index.html").write_text(
                    html + "\n", encoding="utf-8", newline="\n"
                )
                with self.assertRaises(publisher.PublisherError) as caught:
                    publisher.read_bundle(source)
                self.assertEqual(expected_error, caught.exception.kind)

    def test_delete_failure_restores_target_and_retry_removes_it(self) -> None:
        source = self.make_source("delete-failure")
        work_id, bundle, _ = self.publish_source(source)
        target = self.site / "p" / work_id
        removal_root = self.site / "p" / publisher.REMOVAL_DIR_NAME
        tombstone = removal_root / work_id
        journal = removal_root / f"{work_id}.json"

        with mock.patch.object(
            publisher.shutil,
            "rmtree",
            side_effect=PermissionError("deterministic locked-file failure"),
        ):
            with self.assertRaises(publisher.PublisherError) as caught:
                publisher.remove(self.site, work_id, bundle.content_digest)

        self.assertEqual("removal_delete_failed_restored", caught.exception.kind)
        self.assertEqual("target_restored", caught.exception.details["recovery_state"])
        self.assertTrue(target.is_dir())
        self.assertFalse(tombstone.exists())
        self.assertFalse(journal.exists())
        publisher.verify(self.site, work_id, bundle.content_digest)

        self.assertEqual(
            "removed",
            publisher.remove(self.site, work_id, bundle.content_digest)["status"],
        )
        self.assertEqual(
            "absent",
            publisher.remove(self.site, work_id, bundle.content_digest)["status"],
        )

    def test_failed_restore_is_discoverable_and_retry_finishes_removal(self) -> None:
        source = self.make_source("restore-failure")
        work_id, bundle, _ = self.publish_source(source)
        target = self.site / "p" / work_id
        removal_root = self.site / "p" / publisher.REMOVAL_DIR_NAME
        tombstone = removal_root / work_id
        journal = removal_root / f"{work_id}.json"
        real_rename = publisher.os.rename

        def deterministic_rename(source_path, destination_path):
            if Path(source_path) == tombstone and Path(destination_path) == target:
                raise PermissionError("deterministic restore failure")
            return real_rename(source_path, destination_path)

        with mock.patch.object(
            publisher.shutil,
            "rmtree",
            side_effect=PermissionError("deterministic delete failure"),
        ), mock.patch.object(publisher.os, "rename", side_effect=deterministic_rename):
            with self.assertRaises(publisher.PublisherError) as caught:
                publisher.remove(self.site, work_id, bundle.content_digest)

        self.assertEqual("removal_delete_failed_quarantined", caught.exception.kind)
        self.assertEqual(
            "tombstone_and_journal_preserved",
            caught.exception.details["recovery_state"],
        )
        self.assertFalse(target.exists())
        self.assertTrue(tombstone.is_dir())
        self.assertTrue(journal.is_file())

        self.assertEqual(
            "removed",
            publisher.remove(self.site, work_id, bundle.content_digest)["status"],
        )
        self.assertFalse(tombstone.exists())
        self.assertFalse(journal.exists())
        self.assertEqual(
            "absent",
            publisher.remove(self.site, work_id, bundle.content_digest)["status"],
        )

    def test_removal_collision_preserves_both_states_and_never_reports_absent(self) -> None:
        source = self.make_source("removal-collision")
        work_id, bundle, _ = self.publish_source(source)
        target = self.site / "p" / work_id
        removal_root = self.site / "p" / publisher.REMOVAL_DIR_NAME
        tombstone = removal_root / work_id
        journal = removal_root / f"{work_id}.json"
        real_copytree = publisher.shutil.copytree

        def collide_then_fail(path):
            real_copytree(path, target)
            raise PermissionError("deterministic concurrent target collision")

        with mock.patch.object(
            publisher.shutil, "rmtree", side_effect=collide_then_fail
        ):
            with self.assertRaises(publisher.PublisherError) as first_failure:
                publisher.remove(self.site, work_id, bundle.content_digest)

        self.assertEqual(
            "removal_delete_failed_quarantined", first_failure.exception.kind
        )
        self.assertEqual(
            "target_collision_tombstone_preserved",
            first_failure.exception.details["recovery_state"],
        )
        self.assertTrue(target.is_dir())
        self.assertTrue(tombstone.is_dir())
        self.assertTrue(journal.is_file())

        with self.assertRaises(publisher.PublisherError) as retry_failure:
            publisher.remove(self.site, work_id, bundle.content_digest)
        self.assertEqual("removal_recovery_collision", retry_failure.exception.kind)

        for operation in (
            lambda: publisher.publish(
                self.site, source, work_id, bundle.content_digest
            ),
            lambda: publisher.verify(self.site, work_id, bundle.content_digest),
        ):
            with self.assertRaises(publisher.PublisherError) as guarded:
                operation()
            self.assertEqual("removal_incomplete", guarded.exception.kind)

        self.assertTrue(target.is_dir())
        self.assertTrue(tombstone.is_dir())
        self.assertTrue(journal.is_file())

    def test_crash_after_move_is_recovered_after_os_lock_release(self) -> None:
        source = self.make_source("crash-after-move")
        work_id, bundle, _ = self.publish_source(source)
        p_root = self.site / "p"
        target = p_root / work_id
        removal_root = p_root / publisher.REMOVAL_DIR_NAME
        journal = removal_root / f"{work_id}.json"
        tombstone = removal_root / work_id
        publisher._write_removal_journal(
            journal,
            publisher._removal_payload(
                work_id, bundle.content_digest, "deleting"
            ),
            exclusive=True,
        )
        publisher.os.rename(target, tombstone)

        self.assertFalse(target.exists())
        self.assertTrue(journal.is_file())
        self.assertTrue(tombstone.is_dir())
        recovered = publisher.remove(self.site, work_id, bundle.content_digest)
        self.assertEqual("removed", recovered["status"])
        self.assertFalse(target.exists())
        self.assertFalse(journal.exists())
        self.assertFalse(tombstone.exists())
        self.assertEqual(
            "absent",
            publisher.remove(self.site, work_id, bundle.content_digest)["status"],
        )

    def test_crash_after_tombstone_delete_finalizes_removed_not_absent(self) -> None:
        source = self.make_source("crash-after-delete")
        work_id, bundle, _ = self.publish_source(source)
        p_root = self.site / "p"
        target = p_root / work_id
        removal_root = p_root / publisher.REMOVAL_DIR_NAME
        journal = removal_root / f"{work_id}.json"
        tombstone = removal_root / work_id
        publisher._write_removal_journal(
            journal,
            publisher._removal_payload(
                work_id, bundle.content_digest, "deleting"
            ),
            exclusive=True,
        )
        publisher.os.rename(target, tombstone)
        publisher.shutil.rmtree(tombstone)

        self.assertFalse(target.exists())
        self.assertTrue(journal.is_file())
        self.assertFalse(tombstone.exists())
        recovered = publisher.remove(self.site, work_id, bundle.content_digest)
        self.assertEqual("removed", recovered["status"])
        self.assertFalse(journal.exists())
        self.assertEqual(
            "absent",
            publisher.remove(self.site, work_id, bundle.content_digest)["status"],
        )

    def test_concurrent_remover_is_rejected_while_os_lock_is_held(self) -> None:
        source = self.make_source("concurrent-remove")
        work_id, bundle, _ = self.publish_source(source)
        entered_delete = threading.Event()
        release_delete = threading.Event()
        real_rmtree = publisher.shutil.rmtree

        def blocking_delete(path):
            entered_delete.set()
            if not release_delete.wait(timeout=10):
                raise TimeoutError("test did not release deletion")
            return real_rmtree(path)

        with mock.patch.object(
            publisher.shutil, "rmtree", side_effect=blocking_delete
        ), ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(
                publisher.remove, self.site, work_id, bundle.content_digest
            )
            self.assertTrue(entered_delete.wait(timeout=10))
            second = executor.submit(
                publisher.remove, self.site, work_id, bundle.content_digest
            )
            try:
                with self.assertRaises(publisher.PublisherError) as caught:
                    second.result(timeout=10)
                self.assertEqual("removal_in_progress", caught.exception.kind)
                self.assertEqual(
                    "active_lock_preserved",
                    caught.exception.details["recovery_state"],
                )
            finally:
                release_delete.set()
            self.assertEqual("removed", first.result(timeout=10)["status"])

    def test_post_move_verification_blocks_toctou_target_swap(self) -> None:
        original_source = self.make_source("toctou-original", "Original")
        replacement_source = self.make_source("toctou-replacement", "Replacement")
        work_id, original_bundle, _ = self.publish_source(original_source)

        replacement_site = self.base / "replacement-site"
        replacement_site.mkdir()
        replacement_bundle = publisher.read_bundle(replacement_source)
        publisher.publish(
            replacement_site,
            replacement_source,
            work_id,
            replacement_bundle.content_digest,
        )
        replacement = replacement_site / "p" / work_id
        target = self.site / "p" / work_id
        removal_root = self.site / "p" / publisher.REMOVAL_DIR_NAME
        tombstone = removal_root / work_id
        real_rename = publisher.os.rename
        real_rmtree = publisher.shutil.rmtree
        swapped = False

        def swap_before_move(source_path, destination_path):
            nonlocal swapped
            if (
                not swapped
                and Path(source_path) == target
                and Path(destination_path) == tombstone
            ):
                swapped = True
                real_rmtree(target)
                publisher.shutil.copytree(replacement, target)
            return real_rename(source_path, destination_path)

        with mock.patch.object(
            publisher.os, "rename", side_effect=swap_before_move
        ):
            with self.assertRaises(publisher.PublisherError) as caught:
                publisher.remove(
                    self.site, work_id, original_bundle.content_digest
                )

        self.assertTrue(swapped)
        self.assertEqual(
            "removal_verification_failed_restored", caught.exception.kind
        )
        self.assertEqual("content_conflict", caught.exception.details["cause_error"])
        replacement_state = json.loads(
            (target / "prototype.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            replacement_bundle.content_digest,
            replacement_state["content_digest"],
        )
        self.assertFalse(tombstone.exists())


if __name__ == "__main__":
    unittest.main()
