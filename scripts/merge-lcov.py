#!/usr/bin/env python3
"""Smart-merge Vitest Istanbul + Deno V8 LCOV into one SonarCloud report.

Kept as a standalone file (not an embedded heredoc in test-coverage.sh) so
concurrent edits to the Deno test file list cannot tear the merge Python
mid-run — that previously produced SyntaxError: unmatched ']' on a corrupted
line like ``primary_hits = lint]:``.

Merge rule (matches turbopanel/AGENTS.md):
  Per SF, the report with more covered lines (LH) is primary. Secondary may
  only max shared hits or add *executed* lines — never zero-hit V8 transitive
  rows that dilute Workers/DO Istanbul.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def parse_records(path: Path) -> dict[str, list[str]]:
    records: dict[str, list[str]] = {}
    current_sf: str | None = None
    current_lines: list[str] = []

    def flush() -> None:
        nonlocal current_sf, current_lines
        if current_sf is None:
            return
        records[current_sf] = current_lines
        current_sf = None
        current_lines = []

    for line in path.read_text().splitlines():
        if line.startswith("SF:"):
            flush()
            current_sf = line[3:]
            current_lines = [line]
        elif current_sf is not None:
            current_lines.append(line)
            if line == "end_of_record":
                flush()

    flush()
    return records


def line_hits(record_lines: list[str]) -> dict[int, int]:
    hits: dict[int, int] = {}
    for line in record_lines:
        if not line.startswith("DA:"):
            continue
        line_no, count = line[3:].split(",", 1)
        hits[int(line_no)] = max(hits.get(int(line_no), 0), int(count))
    return hits


def branch_hits(record_lines: list[str]) -> dict[str, int]:
    hits: dict[str, int] = {}
    for line in record_lines:
        if not line.startswith("BRDA:"):
            continue
        # LCOV uses "-" for never-taken branches; treat as 0.
        raw = line.rsplit(",", 1)[-1]
        count = 0 if raw == "-" else int(raw)
        hits[line[5:]] = max(hits.get(line[5:], 0), count)
    return hits


def covered_line_count(record_lines: list[str]) -> int:
    return sum(1 for count in line_hits(record_lines).values() if count > 0)


def smart_merge_hits(
    primary: dict[int, int],
    secondary: dict[int, int],
) -> dict[int, int]:
    """Primary coverable lines + max hits from secondary; add secondary-only hit lines.

    Avoids Deno V8 zero-hit transitive lines diluting a healthy Vitest
    (Istanbul) Workers/DO measurement, while still letting real Deno unit
    coverage replace Vitest records that only imported a module (LH:0).
    """
    merged = dict(primary)
    for line_no, count in secondary.items():
        if line_no in merged:
            merged[line_no] = max(merged[line_no], count)
        elif count > 0:
            merged[line_no] = count
    return merged


def merge_sf_records(
    primary_lines: list[str],
    secondary_lines: list[str] | None = None,
) -> list[str]:
    primary_hits = line_hits(primary_lines)
    primary_branches = branch_hits(primary_lines)
    if secondary_lines is None:
        line_hits_merged = primary_hits
        branch_hits_merged = primary_branches
    else:
        secondary_hits = line_hits(secondary_lines)
        secondary_branches = branch_hits(secondary_lines)
        line_hits_merged = smart_merge_hits(primary_hits, secondary_hits)
        branch_hits_merged = dict(primary_branches)
        for key, count in secondary_branches.items():
            if key in branch_hits_merged:
                branch_hits_merged[key] = max(branch_hits_merged[key], count)
            elif count > 0:
                branch_hits_merged[key] = count

    sf_line = next(
        (line for line in primary_lines if line.startswith("SF:")),
        "SF:unknown",
    )
    body: list[str] = [sf_line]
    for line_no in sorted(line_hits_merged):
        body.append(f"DA:{line_no},{line_hits_merged[line_no]}")
    body.append(f"LF:{len(line_hits_merged)}")
    body.append(f"LH:{sum(1 for count in line_hits_merged.values() if count > 0)}")

    if branch_hits_merged:
        for key in sorted(branch_hits_merged):
            body.append(f"BRDA:{key},{branch_hits_merged[key]}")
        body.append(f"BRF:{len(branch_hits_merged)}")
        body.append(
            f"BRH:{sum(1 for count in branch_hits_merged.values() if count > 0)}"
        )

    body.append("end_of_record")
    return body


def merge_lcov(vitest_path: Path, deno_path: Path, out_path: Path) -> None:
    vitest_records = parse_records(vitest_path)
    deno_records = parse_records(deno_path)
    # Pair Vitest + Deno per SF:
    # - Vitest-only → Vitest (Workers/DO path).
    # - Deno-only → Deno (host-free unit suites).
    # - Both → whichever has more covered lines is primary; secondary may only
    #   raise hits or add *executed* lines (never zero-hit dilution).
    all_sf = set(vitest_records) | set(deno_records)
    merged: dict[str, list[str]] = {}
    for sf in sorted(all_sf):
        v = vitest_records.get(sf)
        d = deno_records.get(sf)
        if v is None:
            assert d is not None
            merged[sf] = d
            continue
        if d is None:
            merged[sf] = v
            continue
        if covered_line_count(d) > covered_line_count(v):
            merged[sf] = merge_sf_records(d, v)
        else:
            merged[sf] = merge_sf_records(v, d)

    out_lines: list[str] = []
    for sf in sorted(merged):
        out_lines.extend(merged[sf])
    out_path.write_text("\n".join(out_lines) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--vitest",
        type=Path,
        default=Path("coverage/vitest/lcov.info"),
        help="Vitest Istanbul LCOV (repo-relative SF paths)",
    )
    parser.add_argument(
        "--deno",
        type=Path,
        default=Path("coverage/deno.lcov"),
        help="Deno V8 LCOV (repo-relative SF paths)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("coverage/lcov.info"),
        help="Merged LCOV output path",
    )
    args = parser.parse_args(argv)
    if not args.vitest.is_file():
        print(f"missing Vitest LCOV: {args.vitest}", file=sys.stderr)
        return 1
    if not args.deno.is_file():
        print(f"missing Deno LCOV: {args.deno}", file=sys.stderr)
        return 1
    merge_lcov(args.vitest, args.deno, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
