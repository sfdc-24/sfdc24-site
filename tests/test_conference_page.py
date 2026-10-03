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

JOIN = "https://conference-gateway-96522051727.us-central1.run.app/"

def test_join_url_is_the_gateway():
    text = PAGE.read_text(encoding="utf-8")
    assert text.count(JOIN) == 2
    assert 'href="' + JOIN + '"' in text
    assert "Google sign-in" in text

def test_join_control_comes_before_the_status_cards():
    text = PAGE.read_text(encoding="utf-8")
    assert text.find("Join the conference line") < text.find("Spike A")
