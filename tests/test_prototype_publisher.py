from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


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
        self.assertEqual("content_conflict", caught.exception.kind)
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
            lambda: publisher.publish(
                self.site, source, work_id, bundle.content_digest
            ),
            lambda: publisher.verify(self.site, work_id, bundle.content_digest),
            lambda: publisher.remove(self.site, work_id, bundle.content_digest),
        )
        for operation in operations:
            with self.assertRaises(publisher.PublisherError) as caught:
                operation()
            self.assertEqual("artifact_drift", caught.exception.kind)
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


if __name__ == "__main__":
    unittest.main()
