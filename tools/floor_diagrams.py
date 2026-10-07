#!/usr/bin/env python3
"""Build Mermaid diagrams for the Redis floor from repo data.

Inputs:
  data/ops-delivery.json   checked-in delivery snapshot (sheet-backed, not Redis)
  data/floor/model.json    keyspace, roles, and the handoff chain

Outputs:
  floor/diagrams/*.mmd
  floor/diagrams/delivery.json

No network, no credentials, no live Redis counts.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DELIVERY = ROOT / "data" / "ops-delivery.json"
MODEL = ROOT / "data" / "floor" / "model.json"
OUT = ROOT / "floor" / "diagrams"

STAGES = ("backlog", "dev", "test", "staging", "production")
LANES = (
    ("conference", "Conference line"),
    ("sfdc24", "sfdc24.com"),
    ("blackboard", "Blackboard"),
)


def lane_of(item: dict) -> str:
    src = item.get("source") or ""
    project = item.get("project") or ""
    if "Blackboard" in src:
        return "blackboard"
    if project == "Conference" or "/conference" in src:
        return "conference"
    return "sfdc24"


def clean(text: str, limit: int = 72) -> str:
    text = re.sub(r"#\d+\b", "", text or "")
    text = text.replace('"', "'").replace("[", "(").replace("]", ")")
    text = text.replace("<", "").replace(">", "").replace("#", "")
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


def load() -> tuple[dict, dict]:
    delivery = json.loads(DELIVERY.read_text(encoding="utf-8"))
    model = json.loads(MODEL.read_text(encoding="utf-8"))
    return delivery, model


def delivery_view(delivery: dict) -> dict:
    lanes = {key: {"id": key, "title": title, "items": []} for key, title in LANES}
    for item in delivery.get("items") or []:
        key = lane_of(item)
        lanes[key]["items"].append({
            "id": item.get("id") or "",
            "title": clean(item.get("title") or "", 140),
            "stage": item.get("stage") or "backlog",
            "status": item.get("status") or "",
            "owner": item.get("owner") or "",
        })
    return {
        "source": "data/ops-delivery.json",
        "observed_at": delivery.get("observed_at") or "",
        "label": "delivery-snapshot",
        "note": "Counts and titles come from the checked-in delivery snapshot. They are not Redis numbers.",
        "lanes": lanes,
    }


def lane_diagram(key: str, title: str, items: list[dict]) -> str:
    lines = ["flowchart LR"]
    prev = None
    for stage in STAGES:
        group = [it for it in items if it["stage"] == stage]
        body = f"{stage} · {len(group)}"
        for it in group[:3]:
            body += "\\n" + clean(it["title"], 42)
        extra = len(group) - 3
        if extra > 0:
            body += f"\\n+{extra} more"
        node = f"{key}_{stage}"
        lines.append(f'  {node}["{body}"]')
        if prev:
            lines.append(f"  {prev} --> {node}")
        prev = node
    lines.append(f"  %% {clean(title, 40)}")
    return "\n".join(lines) + "\n"


def stack_diagram(view: dict) -> str:
    lines = [
        "flowchart TB",
        '  sheet["Blackboard sheet\\nSystem of record"]',
        '  redis["redis-central\\nShadow only\\nGate held\\nNo live count"]',
        '  stack["Higher-level stack"]',
    ]
    for key, _title in LANES:
        lane = view["lanes"][key]
        count = len(lane["items"])
        lines.append(f'  {key}["{clean(lane["title"], 40)}\\n{count} in the snapshot"]')
        lines.append(f"  {key} --> stack")
    lines.append("  sheet --> stack")
    lines.append("  sheet -.-> redis")
    lines.append("  redis -.-> stack")
    return "\n".join(lines) + "\n"


def keys_diagram(model: dict) -> str:
    lines = ["flowchart TB"]
    groups: dict[str, list[tuple[int, dict]]] = {}
    for i, key in enumerate(model["keys"]):
        groups.setdefault(key["group"], []).append((i, key))
    for g, (name, rows) in enumerate(groups.items()):
        gid = f"g{g}"
        lines.append(f'  subgraph {gid}["{clean(name, 40)}"]')
        for i, key in rows:
            label = clean(f"{key['pattern']} · {key['type']}", 64)
            lines.append(f'    k{i}["{label}"]')
        lines.append("  end")
    return "\n".join(lines) + "\n"


def chain_diagram(model: dict) -> str:
    by_id = {role["id"]: role for role in model["roles"]}
    lines = ["sequenceDiagram"]
    seen: list[str] = []
    for step in model["steps"]:
        for who in (step["from"], step["to"]):
            if who in seen:
                continue
            seen.append(who)
            role = by_id.get(who, {"name": who, "duty": ""})
            lines.append(f"  participant {who} as {clean(role['name'] + ' ' + role['duty'], 48)}")
    for step in model["steps"]:
        arrow = "-->>" if step.get("kind") == "return" else "->>"
        lines.append(f"  {step['from']}{arrow}{step['to']}: {clean(step['label'], 48)}")
    return "\n".join(lines) + "\n"


def build() -> dict[str, str]:
    delivery, model = load()
    view = delivery_view(delivery)
    files = {
        "stack.mmd": stack_diagram(view),
        "keys.mmd": keys_diagram(model),
        "chain.mmd": chain_diagram(model),
        "delivery.json": json.dumps(view, indent=2, ensure_ascii=False) + "\n",
    }
    for key, title in LANES:
        files[f"{key}.mmd"] = lane_diagram(key, title, view["lanes"][key]["items"])
    return files


def write() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, text in build().items():
        (OUT / name).write_text(text, encoding="utf-8", newline="\n")


def check() -> int:
    current = build()
    drifted = []
    for name, text in current.items():
        path = OUT / name
        if not path.is_file() or path.read_text(encoding="utf-8") != text:
            drifted.append(name)
    if drifted:
        print("floor diagrams drifted: " + ", ".join(drifted))
        return 1
    print("floor diagrams match the data")
    return 0


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        sys.exit(check())
    write()
    print("wrote " + ", ".join(sorted(build())))
