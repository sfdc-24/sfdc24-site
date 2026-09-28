                {\"id\": \"SA-WED-PORTAL\",\""",
    """            \"open_work\": [
                {\"id\": \"OKF-OPS-HUB\", \"from\": \"grok\", \"to\": [\"codex\", \"cursor\"], \"phase\": \"DISPATCH\", \"age_min\": 8, \"next\": True, \"lane\": \"cooking\", \"title\": \"Living OKF hub on Ops for packs, how we work, and release links.\"},
                {\"id\": \"SA-WED-PORTAL\",\""",
)
must(
    "tools/board_ops_snap.py",
    """                {\"id\": \"ORG-AI-INV\", \"from\": \"codex\", \"to\": [\"gemini\"], \"phase\": \"REVIEW\", \"age_min\": 90, \"next\": True, \"lane\": \"cooking\", \"title\": \"Org AI inventory across client orgs and enablement lanes.\"},
                {\"id\": \"GROK-OPS-0142\",\""",
    """                {\"id\": \"ORG-AI-INV\", \"from\": \"codex\", \"to\": [\"gemini\"], \"phase\": \"REVIEW\", \"age_min\": 90, \"next\": True, \"lane\": \"cooking\", \"title\": \"Org AI inventory across client orgs and enablement lanes.\"},
                {\"id\": \"CONF-LINE-FUNNEL\", \"from\": \"grok\", \"to\": [\"cursor\", \"claude-code-cli\"], \"phase\": \"ACK\", \"age_min\": 400, \"lane\": \"backlog\", \"title\": \"Conference Line LiveKit spike on the shared room contract.\"},
                {\"id\": \"GROK-OPS-0142\",\""",
)
expected = {
    "assets/board-ops.part-a.js": "432f20dfa65707538f19a82aec4d9a4e094d6723",
    "assets/ops-board-a.css": "b4f28d70bac732ddebddcabc02bcfb645be6e991",
    "tests/board_ops.cjs": "41075fa92338bb9c5da2375e9e6cde36f411f3c6",
    "tests/header-release.spec.cjs": "0549d77b01ac7a02a2a4f1f46b488496828e6af2",
    "tests/ops_gantt.cjs": "e7c61d1d222e5ccbe948f57bfce86e3063453f5c",
    "tests/test_board_ops_schema.py": "ac47d1a6c44fbd76b6a66fc8e49532fd61c7d08c",
    "tools/board_ops_snap.py": "7a80ddd7fce1f10d7c9e91825ba492090e0d2567",
}
for path, sha in expected.items():
    got = blob(Path(path).read_text())
    if got != sha:
        raise SystemExit(path + " hash " + got + " != " + sha)
print("okf remainder hashes match")
