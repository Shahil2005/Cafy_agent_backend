"""
Rebuild ProductBackend/data/ireland-employment-permits-merged.json from DETE xlsx.

Keeps 2020–2024 from the previous merged file; refreshes 2025–2026 from DETE downloads.
Monthly fields (Jan–Jul) are 2026 YTD only (matches hub UI).

Usage:
  python scripts/mergeIrelandPermits.py
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "data" / "ireland-source"
OUT = ROOT / "data" / "ireland-employment-permits-merged.json"
OUT_CAFY_JOBS = ROOT.parent / "CAFY-JOBS" / "data" / "ireland" / "raw" / "ireland-employment-permits-merged.json"

YEARS = ["2020", "2021", "2022", "2023", "2024", "2025", "2026"]
MONTH_KEYS = [
    "permitsJan",
    "permitsFeb",
    "permitsMar",
    "permitsApr",
    "permitsMay",
    "permitsJun",
    "permitsJul",
]


def norm(name: str) -> str:
    return " ".join((name or "").strip().split()).casefold()


def as_int(v) -> int:
    if v is None or v == "":
        return 0
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def is_summary_row(name: str) -> bool:
    """Skip DETE spreadsheet aggregate rows (not real employers)."""
    n = norm(name)
    return n in {"total", "grand total", "overall total", "totals"}


def empty_year_map() -> dict[str, int]:
    return {y: 0 for y in YEARS}


def empty_employer(name: str) -> dict:
    return {
        "employerName": name.strip(),
        "permitsByYear": empty_year_map(),
        "permitsJan": 0,
        "permitsFeb": 0,
        "permitsMar": 0,
        "permitsApr": 0,
        "permitsMay": 0,
        "permitsJun": 0,
        "permitsJul": 0,
        "totalPermits": 0,
    }


def load_existing() -> dict[str, dict]:
    raw = json.loads(OUT.read_text(encoding="utf-8"))
    out: dict[str, dict] = {}
    for row in raw.get("employers") or []:
        name = (row.get("employerName") or "").strip()
        if not name:
            continue
        emp = empty_employer(name)
        by = row.get("permitsByYear") or {}
        for y in YEARS:
            if y in ("2025", "2026"):
                continue  # refreshed from xlsx
            emp["permitsByYear"][y] = as_int(by.get(y))
        out[norm(name)] = emp
    return out


def parse_2025(path: Path, employers: dict[str, dict]) -> None:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = ws.iter_rows(values_only=True)
    header = next(rows)
    # (None, January...December, Grand Total, None) OR similar
    # Employer is col 0; Grand Total is last non-null month total col
    for row in rows:
        name = str(row[0] or "").strip()
        if not name or is_summary_row(name):
            continue
        total = as_int(row[13] if len(row) > 13 else None)
        if total <= 0:
            # fallback: sum months
            total = sum(as_int(row[i]) for i in range(1, 13) if len(row) > i)
        if total <= 0:
            continue
        key = norm(name)
        emp = employers.get(key) or empty_employer(name)
        emp["employerName"] = name  # prefer latest spelling
        emp["permitsByYear"]["2025"] = total
        employers[key] = emp
    wb.close()


def parse_2026(path: Path, employers: dict[str, dict]) -> None:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = ws.iter_rows(values_only=True)
    header = [str(h or "").strip() for h in next(rows)]
    # Employer Name, Jan..Jul, Grand Total
    for row in rows:
        name = str(row[0] or "").strip()
        if not name or is_summary_row(name):
            continue
        months = [as_int(row[i]) if len(row) > i else 0 for i in range(1, 8)]
        total = as_int(row[8] if len(row) > 8 else None)
        if total <= 0:
            total = sum(months)
        if total <= 0:
            continue
        key = norm(name)
        emp = employers.get(key) or empty_employer(name)
        emp["employerName"] = name
        emp["permitsByYear"]["2026"] = total
        for mk, val in zip(MONTH_KEYS, months):
            emp[mk] = val
        employers[key] = emp
    wb.close()
    _ = header


def finalize(employers: dict[str, dict]) -> dict:
    cleaned = []
    by_year_permits = {y: 0 for y in YEARS}
    by_year_employers = {y: 0 for y in YEARS}

    for emp in employers.values():
        name = (emp.get("employerName") or "").strip()
        if not name or is_summary_row(name):
            continue
        total = sum(as_int(emp["permitsByYear"].get(y)) for y in YEARS)
        if total <= 0:
            continue
        emp["totalPermits"] = total
        # drop zero years for compactness? keep all years for API stability
        cleaned.append(emp)
        for y in YEARS:
            n = as_int(emp["permitsByYear"].get(y))
            if n > 0:
                by_year_permits[y] += n
                by_year_employers[y] += 1

    cleaned.sort(key=lambda e: (-e["totalPermits"], e["employerName"].casefold()))

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "years": [int(y) for y in YEARS],
        "stats": {
            "totalEmployers": len(cleaned),
            "totalPermitsIssued": sum(e["totalPermits"] for e in cleaned),
            "byYear": {
                y: {"employers": by_year_employers[y], "permits": by_year_permits[y]}
                for y in YEARS
            },
        },
        "employers": cleaned,
    }


def main() -> None:
    x2025 = SRC / "permits-2025.xlsx"
    x2026 = SRC / "permits-2026.xlsx"
    if not x2025.exists() or not x2026.exists():
        raise SystemExit(f"Missing source xlsx in {SRC}")

    employers = load_existing()
    parse_2025(x2025, employers)
    parse_2026(x2026, employers)
    payload = finalize(employers)

    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    OUT.write_text(text, encoding="utf-8")
    if OUT_CAFY_JOBS.parent.exists():
        OUT_CAFY_JOBS.write_text(text, encoding="utf-8")

    s = payload["stats"]
    print("generatedAt", payload["generatedAt"])
    print("employers", s["totalEmployers"], "permits", s["totalPermitsIssued"])
    print("byYear", s["byYear"])
    g = next((e for e in payload["employers"] if "google ireland" in e["employerName"].casefold()), None)
    print("Google sample", g)


if __name__ == "__main__":
    main()
