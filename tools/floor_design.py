#!/usr/bin/env python3
"""Design frames for the Redis floor, in the sfdc24.com cobalt tokens.

Penpot is not available in this environment (no Docker, no Penpot service).
These SVGs are the design source. They are not a Penpot file and not a
Penpot export.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "design" / "floor"

INK = "#191919"
PAPER = "#FFFFFF"
MUTE = "#666666"
ACCENT = "#0A66C2"
SOFT = "#F3F2EF"
ON_DARK = "#8FC7FF"
RULE = "#D9D6D1"
SANS = "Public Sans, Segoe UI, sans-serif"
SERIF = "Spectral, Georgia, serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, monospace"


def esc(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def header(width: int, label: str) -> str:
    return f'''
  <rect width="{width}" height="56" fill="{INK}"/>
  <text x="28" y="35" fill="{PAPER}" font-family="{SANS}" font-size="17" font-weight="700">SFDC 19:00</text>
  <text x="150" y="34" fill="{ON_DARK}" font-family="{MONO}" font-size="11" letter-spacing="1.6">{esc(label.upper())}</text>
'''


def card(x, y, w, h, title, lines) -> str:
    body = [
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="2" fill="{PAPER}" stroke="{RULE}"/>',
        f'<text x="{x + 16}" y="{y + 28}" fill="{INK}" font-family="{SERIF}" font-size="18">{esc(title)}</text>',
    ]
    yy = y + 52
    for line in lines:
        body.append(
            f'<text x="{x + 16}" y="{yy}" fill="{MUTE}" font-family="{SANS}" font-size="13">{esc(line)}</text>'
        )
        yy += 20
    return "\n  ".join(body)


def button(x, y, label, pressed=False) -> str:
    fill = INK if pressed else PAPER
    color = PAPER if pressed else INK
    w = max(88, 12 * len(label) + 28)
    return (
        f'<rect x="{x}" y="{y}" width="{w}" height="44" fill="{fill}" stroke="{INK}"/>'
        f'<text x="{x + 14}" y="{y + 28}" fill="{color}" font-family="{SANS}" font-size="14" font-weight="600">{esc(label)}</text>'
    )


def frame(name: str, width: int, height: int, label: str, body: str) -> str:
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="{esc(label)}">
  <rect width="{width}" height="{height}" fill="{SOFT}"/>
  {header(width, label)}
  {body}
</svg>
'''


def tokens() -> str:
    swatches = [
        (INK, "Ink #191919"),
        (PAPER, "Paper #FFFFFF"),
        (MUTE, "Mute #666666"),
        (ACCENT, "Accent #0A66C2"),
        (SOFT, "Soft #F3F2EF"),
        (ON_DARK, "On dark #8FC7FF"),
    ]
    bits = ['<text x="32" y="96" fill="#191919" font-family="Spectral, Georgia, serif" font-size="32">Floor tokens</text>',
            f'<text x="32" y="124" fill="{MUTE}" font-family="{SANS}" font-size="14">Five colors. Spectral for titles. Public Sans for UI. Hairline rules. 44px targets.</text>']
    for i, (color, name) in enumerate(swatches):
        x = 32 + (i % 3) * 280
        y = 160 + (i // 3) * 88
        stroke = RULE if color == PAPER else color
        bits.append(f'<rect x="{x}" y="{y}" width="72" height="48" fill="{color}" stroke="{stroke}"/>')
        bits.append(f'<text x="{x + 84}" y="{y + 30}" fill="{INK}" font-family="{SANS}" font-size="14">{esc(name)}</text>')
    bits.append(card(32, 360, 420, 150, "Card", ["White on soft.", "Hairline border.", "No extra hues for status."]))
    bits.append(card(472, 360, 420, 150, "Banner", ["Sample data stays labeled.", "Accent bar on the left.", "Live switch defaults off."]))
    bits.append(button(32, 540, "Acknowledge"))
    bits.append(button(180, 540, "Landed", True))
    bits.append(f'<text x="32" y="620" fill="{MUTE}" font-family="{SANS}" font-size="13">Buttons are at least 44px. A pressed chip inverts to ink.</text>')
    return frame("tokens", 1440, 900, "Tokens", "\n  ".join(bits))


def processes() -> str:
    bits = [
        f'<text x="32" y="100" fill="{INK}" font-family="{SERIF}" font-size="32">Processes</text>',
        f'<text x="32" y="128" fill="{MUTE}" font-family="{SANS}" font-size="15">Assessment, automation, and AI enablement. Snapshot counts, not Redis.</text>',
        card(32, 156, 1376, 120, "Higher-level stack", [
            "Blackboard sheet  →  stack",
            "Conference line, sfdc24.com, and Blackboard feed the stack.",
            "redis-central is a dotted shadow. Gate held. No live count.",
        ]),
    ]
    lanes = [
        ("Conference line", ["backlog", "dev", "test", "staging", "production"]),
        ("sfdc24.com", ["backlog", "dev", "test", "staging", "production"]),
        ("Blackboard", ["backlog", "dev", "test", "staging", "production"]),
    ]
    y = 300
    for title, stages in lanes:
        bits.append(f'<text x="32" y="{y}" fill="{INK}" font-family="{SERIF}" font-size="18">{esc(title)}</text>')
        x = 32
        for stage in stages:
            bits.append(f'<rect x="{x}" y="{y + 16}" width="200" height="64" fill="{PAPER}" stroke="{ACCENT}"/>')
            bits.append(f'<text x="{x + 12}" y="{y + 54}" fill="{INK}" font-family="{MONO}" font-size="13">{esc(stage)}</text>')
            x += 220
        y += 110
    return frame("processes", 1440, 900, "Processes", "\n  ".join(bits))


def tables() -> str:
    rows = [
        ("v1:bus:row:{Row_ID}", "hash", "Mirrored sheet row. Values stay off the page."),
        ("v1:bus:rowids", "set", "Mirrored row ids."),
        ("v1:bus:compare", "stream", "Verdict and counts. Counts hidden while the gate is held."),
        ("v1:agent:{id}", "hash", "Roster copy. The file is the original."),
        ("v1:blackboard:{key}", "string", "Shadow prefix. Never the answer served."),
    ]
    bits = [
        f'<text x="32" y="100" fill="{INK}" font-family="{SERIF}" font-size="32">Tables</text>',
        f'<text x="32" y="128" fill="{MUTE}" font-family="{SANS}" font-size="15">Key schema. Not a live key count. Assessment, automation, and AI enablement.</text>',
    ]
    y = 156
    for pattern, kind, about in rows:
        bits.append(f'<rect x="32" y="{y}" width="1376" height="72" fill="{PAPER}" stroke="{RULE}"/>')
        bits.append(f'<text x="48" y="{y + 30}" fill="{ACCENT}" font-family="{MONO}" font-size="16">{esc(pattern)}</text>')
        bits.append(f'<text x="520" y="{y + 30}" fill="{INK}" font-family="{SANS}" font-size="14">{esc(kind)}</text>')
        bits.append(f'<text x="48" y="{y + 54}" fill="{MUTE}" font-family="{SANS}" font-size="13">{esc(about)}</text>')
        y += 84
    return frame("tables", 1440, 900, "Tables", "\n  ".join(bits))


def chains() -> str:
    steps = [
        ("Grok", "Claude", "Request"),
        ("Claude", "Grok", "Acknowledgement on landing"),
        ("Gemini", "Cursor", "Architecture handoff"),
        ("Cursor", "Codex", "Build handed over to verify"),
        ("Codex", "Claude", "Result"),
        ("Grok", "Owner", "Escalation when pace stalls"),
    ]
    bits = [
        f'<text x="32" y="100" fill="{INK}" font-family="{SERIF}" font-size="32">Chains</text>',
        f'<text x="32" y="128" fill="{MUTE}" font-family="{SANS}" font-size="15">Claude governs. Grok leads strategy and pace. Codex verifies. Gemini architects. Cursor builds.</text>',
    ]
    y = 160
    for src, dst, label in steps:
        bits.append(f'<rect x="32" y="{y}" width="180" height="44" fill="{PAPER}" stroke="{INK}"/>')
        bits.append(f'<text x="48" y="{y + 28}" fill="{INK}" font-family="{SANS}" font-size="14" font-weight="600">{esc(src)}</text>')
        bits.append(f'<text x="230" y="{y + 28}" fill="{ACCENT}" font-family="{SANS}" font-size="16">→</text>')
        bits.append(f'<rect x="260" y="{y}" width="180" height="44" fill="{PAPER}" stroke="{INK}"/>')
        bits.append(f'<text x="276" y="{y + 28}" fill="{INK}" font-family="{SANS}" font-size="14" font-weight="600">{esc(dst)}</text>')
        bits.append(f'<text x="470" y="{y + 28}" fill="{MUTE}" font-family="{SANS}" font-size="15">{esc(label)}</text>')
        y += 64
    bits.append(f'<text x="32" y="{y + 20}" fill="{MUTE}" font-family="{SANS}" font-size="14">Copilot is not on this floor yet. Assessment, automation, and AI enablement.</text>')
    return frame("chains", 1440, 900, "Chains", "\n  ".join(bits))


def conference(width: int, height: int, label: str) -> str:
    bits = [
        f'<text x="20" y="92" fill="{INK}" font-family="{SERIF}" font-size="28">Conference floor</text>',
        f'<text x="20" y="116" fill="{MUTE}" font-family="{SANS}" font-size="13">Assessment, automation, and AI enablement.</text>',
        f'<rect x="20" y="132" width="{width - 40}" height="48" fill="{PAPER}" stroke="{ACCENT}"/>',
        f'<text x="36" y="162" fill="{INK}" font-family="{SANS}" font-size="14">Sample data. Not a live Redis read.</text>',
    ]
    y = 196
    cards = [
        ("Owner-heard acceptance of the shared room", "Grok → Claude", "requested"),
        ("Comparison gate still held", "Codex → Claude", "escalated"),
    ]
    card_w = width - 40
    for title, meta, state in cards:
        bits.append(f'<rect x="20" y="{y}" width="{card_w}" height="168" fill="{PAPER}" stroke="{RULE}"/>')
        bits.append(f'<text x="36" y="{y + 28}" fill="{INK}" font-family="{SERIF}" font-size="16">{esc(title)}</text>')
        bits.append(f'<text x="36" y="{y + 52}" fill="{MUTE}" font-family="{SANS}" font-size="13">{esc(meta)} · {esc(state)} · Sample</text>')
        bits.append(button(36, y + 70, "Acknowledge"))
        bits.append(button(190, y + 70, "Escalate"))
        bits.append(button(36, y + 122, "Claude"))
        bits.append(button(140, y + 122, "Grok"))
        bits.append(button(230, y + 122, "Landed"))
        y += 184
        if y > height - 80:
            break
    return frame(label, width, height, "Conference", "\n  ".join(bits))


def build() -> dict[str, str]:
    return {
        "tokens.svg": tokens(),
        "processes.svg": processes(),
        "tables.svg": tables(),
        "chains.svg": chains(),
        "conference-desktop.svg": conference(1440, 900, "conference-desktop"),
        "conference-mobile.svg": conference(390, 844, "conference-mobile"),
    }


def write() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, text in build().items():
        (OUT / name).write_text(text, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    write()
    print("wrote " + ", ".join(sorted(build())))
