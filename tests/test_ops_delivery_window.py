"""Eastern daytime window. GitHub cron is UTC; this is the local-hour guard."""
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "tools"))
from ops_delivery_window import in_window

UTC = timezone.utc


def at(year, month, day, hour, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=UTC)


class WindowTests(unittest.TestCase):
    def test_daylight_time_keeps_only_the_four_local_hours(self):
        # Wednesday 7 Oct 2026 is Eastern Daylight (UTC-4).
        self.assertTrue(in_window(at(2026, 10, 7, 13)))    # 09:00 EDT
        self.assertFalse(in_window(at(2026, 10, 7, 14)))   # 10:00 EDT, the winter 09:00 slot
        self.assertTrue(in_window(at(2026, 10, 7, 13, 59)))
        self.assertFalse(in_window(at(2026, 10, 7, 15)))   # 11:00 EDT, between slots
        self.assertTrue(in_window(at(2026, 10, 7, 16)))    # 12:00 EDT
        self.assertFalse(in_window(at(2026, 10, 7, 17)))   # 13:00 EDT
        self.assertTrue(in_window(at(2026, 10, 7, 19)))    # 15:00 EDT
        self.assertFalse(in_window(at(2026, 10, 7, 20)))   # 16:00 EDT
        self.assertTrue(in_window(at(2026, 10, 7, 22)))    # 18:00 EDT
        self.assertFalse(in_window(at(2026, 10, 7, 23)))   # 19:00 EDT

    def test_standard_time_uses_the_other_utc_hours(self):
        # Wednesday 2 Dec 2026 is Eastern Standard (UTC-5).
        self.assertFalse(in_window(at(2026, 12, 2, 13)))   # 08:00 EST
        self.assertTrue(in_window(at(2026, 12, 2, 14)))    # 09:00 EST
        self.assertFalse(in_window(at(2026, 12, 2, 16)))   # 11:00 EST
        self.assertTrue(in_window(at(2026, 12, 2, 17)))    # 12:00 EST
        self.assertFalse(in_window(at(2026, 12, 2, 19)))   # 14:00 EST
        self.assertTrue(in_window(at(2026, 12, 2, 20)))    # 15:00 EST
        self.assertFalse(in_window(at(2026, 12, 2, 22)))   # 17:00 EST
        self.assertTrue(in_window(at(2026, 12, 2, 23)))    # 18:00 EST

    def test_weekends_and_a_naive_clock_are_outside(self):
        self.assertFalse(in_window(at(2026, 10, 10, 13)))  # Saturday 09:00 EDT
        self.assertFalse(in_window(at(2026, 10, 11, 13)))  # Sunday 09:00 EDT
        self.assertTrue(in_window(at(2026, 10, 5, 13, 5)))  # Monday 09:05 EDT
        with self.assertRaises(ValueError):
            in_window(datetime(2026, 10, 7, 13, 0))


if __name__ == "__main__":
    unittest.main()
