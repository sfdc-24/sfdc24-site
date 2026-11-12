"""Public /conference page: no internal wiki jargon, no secrets."""
from pathlib import Path

PAGE = Path(__file__).resolve().parents[1] / "conference" / "index.html"

def test_conference_page_exists():
    assert PAGE.is_file()

def test_no_okf_word_on_public_conference_page():
    text = PAGE.read_text(encoding="utf-8")
    assert "OKF" not in text
    assert "okf" not in text.lower()

def test_no_secret_markers():
    text = PAGE.read_text(encoding="utf-8")
    for needle in ("API_KEY", "SECRET", "LIVEKIT_API", "BEGIN PRIVATE"):
        assert needle not in text
