must(
    "tests/test_board_ops_schema.py",
    """        self.assertEqual(
            \"Conference Line LiveKit spike on the shared room contract.\",
            snap[\"open_work\"][0][\"title\"],
        )""",
    """        self.assertEqual(
            \"Living OKF hub on Ops for packs, how we work, and release links.\",
            snap[\"open_work\"][0][\"title\"],
        )""",
)
must(
    "tests/test_board_ops_schema.py",
    """        self.assertEqual(\"cooking\", snap[\"open_work\"][1][\"lane\"])
        self.assertEqual(""",
    """        self.assertEqual(\"cooking\", snap[\"open_work\"][1][\"lane\"])
        parked = next(row for row in snap[\"open_work\"] if row[\"id\"] == \"CONF-LINE-FUNNEL\")
        self.assertEqual(\"backlog\", parked[\"lane\"])
        self.assertNotIn(\"next\", parked)
        self.assertEqual(""",
)
must(
    "tools/board_ops_snap.py",
    '"task": "Strategy lead for LIVE ops funnel"',
    '"task": "Delivery Director for the living OKF hub"',
)
must(
    "tools/board_ops_snap.py",
    """            \"open_work\": [
                {\"id\": \"CONF-LINE-FUNNEL\", \"from\": \"grok\", \"to\": [\"cursor\", \"claude-code-cli\"], \"phase\": \"DISPATCH\", \"age_min\": 8, \"next\": True, \"lane\": \"cooking\", \"title\": \"Conference Line LiveKit spike on the shared room contract.\"},
