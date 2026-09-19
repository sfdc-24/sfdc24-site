#!/usr/bin/env python3
"""Wilson / Beta CI for inference calls. Python owns the numbers.

Prefer statsmodels / scipy when installed; stdlib Wilson always works.
Beta (Clopper-Pearson) and Jeffreys use scipy.stats.beta when present,
else a compact inverse-beta search.

Standing rule (docs/site-doctrine.md, /method/#inference):
  n ≥ 20 + CI before a call. Taste / ethics can still veto.
  ETA learning reads data/estimate-lessons.jsonl.
  A/B assignment is session-local — no cookies.

  python3 tools/inference_ci.py --k 18 --n 40
  python3 tools/inference_ci.py --lessons
  python3 tools/inference_ci.py --validate
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LESSONS = ROOT / "data" / "estimate-lessons.jsonl"
MIN_N = 20
HITS = ("beat", "on_time")
OUTCOMES = ("beat", "on_time", "delayed", "failed")
METHODS = ("wilson", "beta", "jeffreys")
Z_TABLE = {
    0.10: 1.6448536269514722,
    0.05: 1.959963984540054,
    0.01: 2.5758293035489004,
}


def ready(n: int, min_n: int = MIN_N) -> bool:
    return n >= min_n


def _z(alpha: float) -> float:
    if alpha in Z_TABLE:
        return Z_TABLE[alpha]
    # Acklam inverse-norm for N(0,1) at 1 − α/2.
    return _norm_ppf(1.0 - alpha / 2.0)


def _norm_ppf(p: float) -> float:
    if p <= 0.0 or p >= 1.0:
        raise ValueError("p must be in (0, 1)")
    a = (
        -3.969683028665376e01,
        2.209460984245205e02,
        -2.759285104469687e02,
        1.383577509590705e02,
        -3.066479806614716e01,
        2.506628277459239e00,
    )
    b = (
        -5.447609879822406e01,
        1.615858368580409e02,
        -1.556989798598866e02,
        6.680131188771972e01,
        -1.328068155288572e01,
    )
    c = (
        -7.784894002430293e-03,
        -3.223964580411365e-01,
        -2.400758277161838e00,
        -2.549732539343734e00,
        4.374664141464968e00,
        2.938163982698783e00,
    )
    d = (
        7.784695709041462e-03,
        3.224671290700398e-01,
        2.445134137142996e00,
        3.754408661907416e00,
    )
    plow = 0.02425
    phigh = 1.0 - plow
    if p < plow:
        q = math.sqrt(-2.0 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0
        )
    if p > phigh:
        q = math.sqrt(-2.0 * math.log(1.0 - p))
        return -(
            ((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]
        ) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
    q = p - 0.5
    r = q * q
    return (
        (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5])
        * q
        / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0)
    )


def _check_kn(k: int, n: int) -> None:
    if n <= 0:
        raise ValueError("n must be > 0")
    if k < 0 or k > n:
        raise ValueError("k must be in 0..n")


def wilson_ci(k: int, n: int, alpha: float = 0.05) -> tuple[float, float]:
    """Wilson score interval. statsmodels when present; stdlib otherwise."""
    _check_kn(k, n)
    packed = _try_statsmodels(k, n, alpha, "wilson")
    if packed is not None:
        return packed
    z = _z(alpha)
    phat = k / n
    z2 = z * z
    den = 1.0 + z2 / n
    center = (phat + z2 / (2.0 * n)) / den
    spread = z * math.sqrt((phat * (1.0 - phat) + z2 / (4.0 * n)) / n) / den
    lo = max(0.0, center - spread)
    hi = min(1.0, center + spread)
    if lo < 1e-12:
        lo = 0.0
    if hi > 1.0 - 1e-12:
        hi = 1.0
    return (lo, hi)


def beta_ci(k: int, n: int, alpha: float = 0.05) -> tuple[float, float]:
    """Clopper-Pearson (Beta) interval."""
    _check_kn(k, n)
    packed = _try_statsmodels(k, n, alpha, "beta")
    if packed is not None:
        return packed
    lo = 0.0 if k == 0 else _betaincinv(alpha / 2.0, k, n - k + 1)
    hi = 1.0 if k == n else _betaincinv(1.0 - alpha / 2.0, k + 1, n - k)
    return (float(lo), float(hi))


def jeffreys_ci(k: int, n: int, alpha: float = 0.05) -> tuple[float, float]:
    """Jeffreys interval via Beta(k+½, n−k+½)."""
    _check_kn(k, n)
    packed = _try_scipy_beta(k + 0.5, n - k + 0.5, alpha)
    if packed is not None:
        return packed
    a, b = k + 0.5, n - k + 0.5
    lo = 0.0 if k == 0 else _betaincinv(alpha / 2.0, a, b)
    hi = 1.0 if k == n else _betaincinv(1.0 - alpha / 2.0, a, b)
    return (float(lo), float(hi))


def interval(
    k: int, n: int, alpha: float = 0.05, method: str = "wilson"
) -> tuple[float, float]:
    if method == "wilson":
        return wilson_ci(k, n, alpha)
    if method == "beta":
        return beta_ci(k, n, alpha)
    if method == "jeffreys":
        return jeffreys_ci(k, n, alpha)
    raise ValueError(f"method must be one of {', '.join(METHODS)}")


def _try_statsmodels(
    k: int, n: int, alpha: float, method: str
) -> tuple[float, float] | None:
    try:
        from statsmodels.stats.proportion import proportion_confint

        lo, hi = proportion_confint(k, n, alpha=alpha, method=method)
        return (float(lo), float(hi))
    except Exception:
        return None


def _try_scipy_beta(a: float, b: float, alpha: float) -> tuple[float, float] | None:
    try:
        from scipy.stats import beta as beta_dist

        return (
            float(beta_dist.ppf(alpha / 2.0, a, b)),
            float(beta_dist.ppf(1.0 - alpha / 2.0, a, b)),
        )
    except Exception:
        return None


def _betainc(a: float, b: float, x: float) -> float:
    """Regularized incomplete beta I_x(a, b)."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    if x > (a + 1.0) / (a + b + 2.0):
        return 1.0 - _betainc(b, a, 1.0 - x)
    ln = (
        a * math.log(x)
        + b * math.log(1.0 - x)
        - math.lgamma(a)
        - math.lgamma(b)
        + math.lgamma(a + b)
    )
    return math.exp(ln) / a * _betacf(a, b, x)


def _betacf(a: float, b: float, x: float, iters: int = 200, eps: float = 3e-12) -> float:
    qab = a + b
    qap = a + 1.0
    qam = a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < 1e-30:
        d = 1e-30
    d = 1.0 / d
    h = d
    for m in range(1, iters + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < 1e-30:
            d = 1e-30
        c = 1.0 + aa / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < 1e-30:
            d = 1e-30
        c = 1.0 + aa / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < eps:
            break
    return h


def _betaincinv(p: float, a: float, b: float) -> float:
    if p <= 0.0:
        return 0.0
    if p >= 1.0:
        return 1.0
    lo, hi = 0.0, 1.0
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if _betainc(a, b, mid) < p:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def load_lessons(path: Path | None = None) -> list[dict[str, Any]]:
    src = path or DEFAULT_LESSONS
    rows: list[dict[str, Any]] = []
    if not src.exists():
        return rows
    for line in src.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            rows.append(obj)
    return rows


def outcome_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts = {key: 0 for key in OUTCOMES}
    for row in rows:
        out = str(row.get("outcome") or "").replace("-", "_")
        if out == "on-time":
            out = "on_time"
        if out in counts:
            counts[out] += 1
    return counts


def hit_count(rows: list[dict[str, Any]]) -> tuple[int, int]:
    n = 0
    k = 0
    for row in rows:
        out = str(row.get("outcome") or "").replace("-", "_")
        if out == "on-time":
            out = "on_time"
        if out not in OUTCOMES:
            continue
        n += 1
        if out in HITS:
            k += 1
    return k, n


def eta_interval(
    path: Path | None = None, alpha: float = 0.05, method: str = "wilson"
) -> dict[str, Any]:
    """CI on ETA hit rate (beat + on_time) / n from estimate-lessons.jsonl."""
    rows = load_lessons(path)
    k, n = hit_count(rows)
    payload: dict[str, Any] = {
        "k": k,
        "n": n,
        "ready": ready(n),
        "method": method,
        "lo": None,
        "hi": None,
        "counts": outcome_counts(rows),
    }
    if n > 0:
        lo, hi = interval(k, n, alpha, method)
        payload["lo"] = lo
        payload["hi"] = hi
    return payload


def assign_ab(session_key: str, variants: tuple[str, ...] = ("a", "b")) -> str:
    """Deterministic session assignment. No cookies."""
    if not session_key or not variants:
        raise ValueError("session_key and variants are required")
    digest = hashlib.sha256(session_key.encode("utf-8")).digest()
    return variants[digest[0] % len(variants)]


def _fmt(lo: float, hi: float) -> str:
    return f"[{lo:.4f}, {hi:.4f}]"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Wilson / Beta CI for inference calls")
    ap.add_argument("--k", type=int, help="Successes")
    ap.add_argument("--n", type=int, help="Trials")
    ap.add_argument("--alpha", type=float, default=0.05, help="Two-sided alpha")
    ap.add_argument("--method", choices=METHODS, default="wilson")
    ap.add_argument("--lessons", action="store_true", help="ETA hit rate from JSONL")
    ap.add_argument("--file", default=str(DEFAULT_LESSONS), help="estimate-lessons path")
    ap.add_argument("--validate", action="store_true", help="Self-check helpers")
    ap.add_argument("--assign", help="Session key → A/B variant (no cookies)")
    args = ap.parse_args(argv)

    if args.validate:
        lo, hi = wilson_ci(10, 20, 0.05)
        if not (lo < 0.5 < hi):
            print("wilson_ci(10, 20) should contain 0.5", file=sys.stderr)
            return 1
        blo, bhi = beta_ci(10, 20, 0.05)
        if not (blo < 0.5 < bhi):
            print("beta_ci(10, 20) should contain 0.5", file=sys.stderr)
            return 1
        if assign_ab("session-a") == "":
            print("assign_ab returned empty", file=sys.stderr)
            return 1
        eta = eta_interval(Path(args.file))
        print(
            f"ok wilson={_fmt(lo, hi)} beta={_fmt(blo, bhi)} "
            f"eta n={eta['n']} ready={eta['ready']}"
        )
        return 0

    if args.assign:
        print(assign_ab(args.assign))
        return 0

    if args.lessons:
        eta = eta_interval(Path(args.file), args.alpha, args.method)
        print(json.dumps(eta, indent=2))
        return 0 if eta["n"] >= 0 else 1

    if args.k is None or args.n is None:
        ap.error("pass --k and --n, or --lessons, --assign, or --validate")
    lo, hi = interval(args.k, args.n, args.alpha, args.method)
    print(
        json.dumps(
            {
                "k": args.k,
                "n": args.n,
                "ready": ready(args.n),
                "method": args.method,
                "lo": lo,
                "hi": hi,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
