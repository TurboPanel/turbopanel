#!/usr/bin/env node
/**
 * Static guardrail: Durable Object cell code must stay hibernation-safe.
 * Strips comments and string literals before matching to avoid false positives.
 *
 * Usage:
 *   node scripts/check-durable-object-hibernation.mjs
 *   node scripts/check-durable-object-hibernation.mjs --fixtures
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CELL_DIR = path.join(ROOT, "src/daemon/cell");
const FIXTURES_DIR = path.join(
  ROOT,
  "scripts/fixtures/check-do-hibernation",
);

const DO_HOSTED = new Set(["src/daemon/cell/do.ts"]);

const DO_FORBIDDEN = [
  { pattern: /\bsetInterval\b/, label: "setInterval" },
  { pattern: /\bsetTimeout\b/, label: "setTimeout" },
  { pattern: /\bscheduler\.wait\b/, label: "scheduler.wait" },
  { pattern: /\bserver\.accept\s*\(/, label: "server.accept(" },
];

const ALL_CELL_FORBIDDEN = [
  { pattern: /\bsetInterval\s*\(/, label: "setInterval(" },
  { pattern: /\bscheduler\.wait\b/, label: "scheduler.wait" },
  { pattern: /\bserver\.accept\s*\(/, label: "server.accept(" },
];

const STABLE_ID_FILES = [
  "src/daemon/cell/do-registry.ts",
  "src/daemon/workers-ws.ts",
];

/** Strip // and block comments, then single/double/template string literals. */
function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < len && source[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len - 1 && !(source[i] === "*" && source[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < len) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      continue;
    }

    if (ch === "`") {
      i += 1;
      while (i < len) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "`") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function collectTsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function relPath(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join("/");
}

function lineNumber(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

function findViolations(source, rules) {
  const stripped = stripCommentsAndStrings(source);
  const hits = [];
  for (const rule of rules) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags + (rule.pattern.global ? "" : "g"));
    let match = re.exec(stripped);
    while (match) {
      hits.push({ label: rule.label, line: lineNumber(stripped, match.index) });
      match = re.exec(stripped);
    }
  }
  return hits;
}

function isAllowedOneShotSetTimeout(stripped, index) {
  const snippet = stripped.slice(index, index + 120);
  return /setTimeout\s*\(\s*(?:\(\s*)?resolve\s*,/.test(snippet);
}

function findSetTimeoutViolations(rel, stripped) {
  const hits = [];
  const re = /\bsetTimeout\s*\(/g;
  let match = re.exec(stripped);
  while (match) {
    const index = match.index;
    if (isAllowedOneShotSetTimeout(stripped, index)) {
      match = re.exec(stripped);
      continue;
    }

    const chunk = stripped.slice(index, index + 600);
    const nested = /\bsetTimeout\s*\(/.exec(chunk.slice(15));
    if (nested) {
      hits.push({
        label: "recurring setTimeout",
        line: lineNumber(stripped, index),
      });
    } else {
      hits.push({
        label: "setTimeout",
        line: lineNumber(stripped, index),
      });
    }
    match = re.exec(stripped);
  }
  return hits;
}

function checkStableDoName(rel, stripped) {
  const hits = [];
  const hasDirectServerId = /\bgetByName\s*\(\s*serverId\b/.test(stripped);
  const hasLogicalNamePattern =
    /\blogicalName\s*=\s*serverId\b/.test(stripped) &&
    /\bgetByName\s*\(\s*logicalName\b/.test(stripped);

  if (!hasDirectServerId && !hasLogicalNamePattern) {
    hits.push({
      label: "getByName must use serverId or logicalName (= serverId)",
      line: 1,
    });
  }

  if (/\bnewUniqueId\s*\(/.test(stripped)) {
    hits.push({ label: "forbidden newUniqueId(", line: 1 });
  }
  if (/\bidFromName\s*\(/.test(stripped)) {
    hits.push({ label: "forbidden idFromName(", line: 1 });
  }

  return hits;
}

export function checkDurableObjectHibernation(options = {}) {
  const root = options.root ?? ROOT;
  const cellDir = options.cellDir ?? path.join(root, "src/daemon/cell");
  const stableIdFiles = options.stableIdFiles ?? STABLE_ID_FILES.map((rel) =>
    path.join(root, rel)
  );
  const extraFiles = options.extraFiles ?? [];
  const violations = [];

  const filesToScan = [
    ...collectTsFiles(cellDir),
    ...extraFiles.map((file) => path.isAbsolute(file) ? file : path.join(root, file)),
  ];

  for (const absPath of filesToScan) {
    const rel = path.relative(root, absPath).split(path.sep).join("/");
    const source = fs.readFileSync(absPath, "utf8");
    const stripped = stripCommentsAndStrings(source);

    const rules = DO_HOSTED.has(rel) ? DO_FORBIDDEN : ALL_CELL_FORBIDDEN;
    for (const hit of findViolations(source, rules)) {
      violations.push(`${rel}:${hit.line} forbidden ${hit.label}`);
    }

    if (!DO_HOSTED.has(rel)) {
      for (const hit of findSetTimeoutViolations(rel, stripped)) {
        violations.push(`${rel}:${hit.line} forbidden ${hit.label}`);
      }
    }

    if (DO_HOSTED.has(rel) && !/\bacceptWebSocket\b/.test(stripped)) {
      violations.push(`${rel}:1 missing acceptWebSocket`);
    }
  }

  for (const absPath of stableIdFiles) {
    const rel = path.relative(root, absPath).split(path.sep).join("/");
    if (!fs.existsSync(absPath)) {
      violations.push(`${rel}:0 file not found`);
      continue;
    }
    const source = fs.readFileSync(absPath, "utf8");
    const stripped = stripCommentsAndStrings(source);
    for (const hit of checkStableDoName(rel, stripped)) {
      violations.push(`${rel}:${hit.line} ${hit.label}`);
    }
  }

  return violations;
}

function runFixturesSelfTest() {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  const badSetTimeoutPath = path.join(FIXTURES_DIR, "bad-settimeout.ts");
  const badGetByNamePath = path.join(FIXTURES_DIR, "bad-getbyname.ts");

  fs.writeFileSync(
    badSetTimeoutPath,
    `export function poll() {
  setTimeout(() => {
    setTimeout(poll, 1000);
  }, 100);
}
`,
  );

  fs.writeFileSync(
    badGetByNamePath,
    `export function resolveStub(env: { DAEMON_CELL: { getByName: (name: string) => unknown } }) {
  const id = crypto.randomUUID();
  return env.DAEMON_CELL.getByName(id);
}
`,
  );

  const setTimeoutViolations = checkDurableObjectHibernation({
    root: ROOT,
    cellDir: FIXTURES_DIR,
    stableIdFiles: [],
    extraFiles: [],
  });

  const stableViolations = checkDurableObjectHibernation({
    root: ROOT,
    cellDir: FIXTURES_DIR,
    stableIdFiles: [badGetByNamePath],
    extraFiles: [],
  });

  const failures = [];
  if (!setTimeoutViolations.some((v) => v.includes("recurring setTimeout"))) {
    failures.push("expected recurring setTimeout fixture to fail");
  }
  if (!stableViolations.some((v) => v.includes("getByName must use serverId"))) {
    failures.push("expected non-server-id getByName fixture to fail");
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    process.exit(1);
  }

  console.log("check-durable-object-hibernation fixtures: ok");
}

const runFixtures = process.argv.includes("--fixtures");

if (runFixtures) {
  runFixturesSelfTest();
  process.exit(0);
}

const violations = checkDurableObjectHibernation();

if (violations.length > 0) {
  for (const v of violations) {
    console.error(v);
  }
  process.exit(1);
}

console.log("check-durable-object-hibernation: ok");
