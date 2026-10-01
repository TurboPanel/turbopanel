#!/usr/bin/env node
/**
 * Forward-only migration guard (r2-deploy-hygiene).
 *
 * A deploy migrates the database first, then ships the new Worker. For the
 * window in between (and for a rollback of the Worker), the PREVIOUS Worker
 * keeps running against the NEW schema. So a migration added in a change may
 * only be backward-compatible with the previous release: add tables, columns,
 * indexes; never drop, rename, retype or tighten something the old code reads.
 * Breaking changes go in two releases (expand, then contract).
 *
 * This guard reads only migration files ADDED since the base ref (shipped
 * files are immutable and already covered by check-migration-additions) and
 * refuses statements that break the previous Worker. A migration that is
 * genuinely safe (the old code never touched the object, or nothing is live
 * yet) opts out with a comment line:
 *
 *   -- breaking-ok: <reason, at least a few words>
 *
 * Usage:
 *   node scripts/check-migration-forward-only.mjs <base-ref>
 *   node scripts/check-migration-forward-only.mjs          # base = origin/trunk
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const NIL_SHA = '0000000000000000000000000000000000000000'
const OPT_OUT = /^[ \t]*--[ \t]*breaking-ok:[ \t]*(\S.{9,})$/m

const RULES = [
  [/\bDROP\s+TABLE\b/i, 'DROP TABLE'],
  [/\bDROP\s+COLUMN\b/i, 'DROP COLUMN'],
  [/\bDROP\s+SCHEMA\b/i, 'DROP SCHEMA'],
  [/\bDROP\s+TYPE\b/i, 'DROP TYPE'],
  [/\bRENAME\s+COLUMN\b/i, 'RENAME COLUMN'],
  [/\bRENAME\s+TO\b/i, 'RENAME TO (table, index or constraint)'],
  [/\bSET\s+NOT\s+NULL\b/i, 'SET NOT NULL'],
  [/\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i, 'ALTER COLUMN TYPE'],
  [/\bTRUNCATE\b/i, 'TRUNCATE'],
]

/** Drop `-- ...` comments so a comment never trips (or hides) a rule. */
function stripComments(sql) {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
}

/**
 * Pure check of one migration file's SQL. Returns the list of breaking
 * statement kinds found; empty when the file is forward-compatible or carries
 * a `-- breaking-ok: <reason>` line.
 */
export function findBreakingStatements(sql) {
  if (OPT_OUT.test(sql)) return []
  const code = stripComments(sql)
  return RULES.filter(([re]) => re.test(code)).map(([, label]) => label)
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function addedMigrations(base) {
  return git('diff', '--name-status', '--diff-filter=A', base, 'HEAD', '--', 'migrations/')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t').pop())
    .filter((file) => /^migrations\/\d{4}_.+\.sql$/.test(file))
}

function main() {
  const requested = process.argv
    .slice(2)
    .find((arg) => arg !== '--')
    ?.trim()
  const base = !requested || requested === NIL_SHA ? 'origin/trunk' : requested
  const problems = []
  for (const file of addedMigrations(base)) {
    const found = findBreakingStatements(fs.readFileSync(file, 'utf8'))
    if (found.length > 0) {
      problems.push(
        `${file}: ${found.join(', ')} would break the previous Worker (it keeps running against the new schema during a deploy or rollback). Split into expand then contract releases, or add a "-- breaking-ok: <reason>" line if it is truly safe.`
      )
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`migration-forward-only: ${problem}`)
    process.exit(1)
  }
  console.log(`migration-forward-only: new migrations since ${base} are forward-compatible`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
