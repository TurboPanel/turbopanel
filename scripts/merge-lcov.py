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

CI shards the Deno run. Pass every shard with repeated ``--deno`` or point
``--parts`` at the downloaded ``lcov-*`` artifacts. Shard reports are unioned
first (max line and branch hits); that combined Deno report is then
smart-merged with Vitest. A single ``--deno`` file takes the historical path.
"""
from __future__ import annotations

import argparse
import re
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


# Artifact directory names produced by .github/workflows/build.yml.
# A missing shard must fail the merge — scanning a partial LCOV would
# publish a green quality gate over tests that never ran.
DENO_PART_NAMES = (
    "lcov-deno-hostfree",
    "lcov-deno-api-routes",
    "lcov-deno-db-1",
    "lcov-deno-db-2",
)

WORKERS_FLOORS = (
    (r"SF:src/daemon/cell/do\.ts\n(?:.*\n)*?LH:(\d+)", 50, "do.ts"),
    (r"SF:src/daemon/cell/do-registry\.ts\n(?:.*\n)*?LH:(\d+)", 80, "do-registry.ts"),
    (r"SF:src/daemon/workers-ws\.ts\n(?:.*\n)*?LH:(\d+)", 10, "workers-ws.ts"),
)


def da_line_count(record_lines: list[str]) -> int:
    return sum(1 for line in record_lines if line.startswith("DA:"))


def union_deno_records(paths: list[Path]) -> dict[str, list[str]]:
    """Max line and branch hits across Deno shards.

    A file that only one shard loaded keeps that shard's record, including
    function rows. A file loaded by several shards keeps the wider line map
    and takes the max hit on every shared line.
    """
    merged: dict[str, list[str]] = {}
    for path in paths:
        for sf, lines in parse_records(path).items():
            current = merged.get(sf)
            if current is None:
                merged[sf] = lines
                continue
            if da_line_count(lines) > da_line_count(current):
                merged[sf] = merge_sf_records(lines, current)
            else:
                merged[sf] = merge_sf_records(current, lines)
    return merged


def merge_record_maps(
    vitest_records: dict[str, list[str]],
    deno_records: dict[str, list[str]],
) -> dict[str, list[str]]:
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
    return merged


def write_records(records: dict[str, list[str]], out_path: Path) -> None:
    out_lines: list[str] = []
    for sf in sorted(records):
        out_lines.extend(records[sf])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(out_lines) + "\n")


def merge_lcov(vitest_path: Path, deno_paths: list[Path], out_path: Path) -> None:
    deno_records = union_deno_records(deno_paths)
    merged = merge_record_maps(parse_records(vitest_path), deno_records)
    write_records(merged, out_path)


def assert_workers_floors(text: str) -> None:
    for pattern, minimum, label in WORKERS_FLOORS:
        match = re.search(pattern, text)
        hits = int(match.group(1)) if match else 0
        if hits < minimum:
            raise SystemExit(
                f"Merged LCOV missing expected {label} coverage (LH:{hits}, need >={minimum})"
            )


def discover_parts(parts: Path) -> tuple[Path, list[Path]]:
    if not parts.is_dir():
        raise SystemExit(f"missing coverage parts directory: {parts}")
    vitest_dir = parts / "lcov-vitest"
    vitest_matches = sorted(vitest_dir.rglob("lcov.info")) if vitest_dir.is_dir() else []
    if len(vitest_matches) != 1:
        raise SystemExit(
            f"expected one lcov.info under {vitest_dir}, found {len(vitest_matches)}"
        )
    found = {
        path.name
        for path in parts.iterdir()
        if path.is_dir() and path.name.startswith("lcov-deno-")
    }
    expected = set(DENO_PART_NAMES)
    if found != expected:
        raise SystemExit(
            "expected deno artifacts "
            + ", ".join(sorted(expected))
            + "; found "
            + (", ".join(sorted(found)) if found else "(none)")
        )
    deno_paths: list[Path] = []
    for name in DENO_PART_NAMES:
        matches = sorted((parts / name).rglob("deno.lcov"))
        if len(matches) != 1:
            raise SystemExit(
                f"expected one deno.lcov under {parts / name}, found {len(matches)}"
            )
        deno_paths.append(matches[0])
    return vitest_matches[0], deno_paths


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
        action="append",
        help="Deno V8 LCOV. Repeat for each CI shard. Default: coverage/deno.lcov",
    )
    parser.add_argument(
        "--parts",
        type=Path,
        help="Directory of downloaded lcov-* artifacts (CI fan-in)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("coverage/lcov.info"),
        help="Merged LCOV output path",
    )
    parser.add_argument(
        "--assert-workers",
        action="store_true",
        help="Fail unless Workers/DO LH floors still clear after the merge",
    )
    args = parser.parse_args(argv)
    if args.parts is not None and args.deno:
        print("pass either --parts or --deno, not both", file=sys.stderr)
        return 1
    if args.parts is not None:
        vitest_path, deno_paths = discover_parts(args.parts)
    else:
        vitest_path = args.vitest
        deno_paths = args.deno if args.deno else [Path("coverage/deno.lcov")]
    if not vitest_path.is_file():
        print(f"missing Vitest LCOV: {vitest_path}", file=sys.stderr)
        return 1
    for deno_path in deno_paths:
        if not deno_path.is_file():
            print(f"missing Deno LCOV: {deno_path}", file=sys.stderr)
            return 1
    merge_lcov(vitest_path, deno_paths, args.out)
    if args.assert_workers:
        assert_workers_floors(args.out.read_text())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
