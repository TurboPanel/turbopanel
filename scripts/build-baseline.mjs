#!/usr/bin/env node
/**
 * One-time tool that wrote the single fresh-start baseline (generation 9 to 10,
 * owner decision 2026-10-17). Removed again by the change that removes the
 * baseline exception in `check-migration-additions.mjs`.
 *
 *   node scripts/build-baseline.mjs
 *
 * 1. deletes every migration file, snapshot and the journal;
 * 2. runs `drizzle-kit generate --name init` against an empty history, so the
 *    result is exactly `schema.ts` (no database is needed);
 * 3. appends the `COMMENT ON` set from `schema-descriptions.ts`
 *    (`schema-comments.mjs` prints all of it because the new history has none);
 * 4. rewrites the manifest with `check-migration-freeze.mjs --rebaseline`.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrations = path.join(root, 'migrations')
const meta = path.join(migrations, 'meta')
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  })

for (const name of fs.readdirSync(migrations)) {
  if (/^\d{4}_.+\.sql$/.test(name)) fs.rmSync(path.join(migrations, name))
}
for (const name of fs.readdirSync(meta)) {
  if (/^\d{4}_snapshot\.json$/.test(name)) fs.rmSync(path.join(meta, name))
}
// drizzle-kit wants a journal to append to: an empty one means "diff against nothing".
fs.writeFileSync(
  path.join(meta, '_journal.json'),
  `${JSON.stringify({ version: '7', dialect: 'postgresql', entries: [] }, null, 2)}\n`
)

run(
  'pnpm',
  ['exec', 'drizzle-kit', 'generate', '--config', 'drizzle.config.mjs', '--name', 'init'],
  {
    env: {
      ...process.env,
      TURBOPANEL_DATABASE_URL:
        process.env.TURBOPANEL_DATABASE_URL ?? 'postgres://u:p@localhost:5432/unused',
    },
  }
)

const file = path.join(migrations, '0000_init.sql')
// The one comment `schema-descriptions.ts` does not carry (sequences have no
// column to describe): the uid/gid sequence.
const SEQUENCE_COMMENT =
  'COMMENT ON SEQUENCE "public"."principal_id_seq" IS \'Installation-wide uid/gid source for new site owner Linux users: one value per principal, the same on every server it is placed on. Starts above the band floor because older hosts picked ids from the bottom.\';'
const comments = `${run('node', ['scripts/schema-comments.mjs'])}--> statement-breakpoint\n${SEQUENCE_COMMENT}\n`
fs.writeFileSync(
  file,
  `${fs.readFileSync(file, 'utf8').trimEnd()}\n--> statement-breakpoint\n${comments}`
)

console.log(run('node', ['scripts/check-migration-freeze.mjs', '--rebaseline']).trim())
