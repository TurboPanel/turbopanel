/**
 * Guard: every sealed (`tpsecret`) column in the schema is a stage of the
 * re-encrypt sweep. Without this, a key could be retired on the strength of a
 * sweep that reported `failed: 0` while a table still held old-key envelopes.
 *
 * Sealed columns are derived from the schema two ways, then unioned:
 * 1. the column's doc comment in `schema.ts` says `tpsecret` / sealed;
 * 2. the column name looks like secret material (envelope, secret, password,
 *    private key, preshared key, `key_pem`).
 * A column that matches but is not sealed must be listed in `NOT_SEALED` with
 * the reason, so the exemption is deliberate and reviewed.
 */

import { assert, assertEquals } from '@std/assert'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import * as schema from '../db/schema.ts'
import { REENCRYPT_COVERED_PLACES } from './reencrypt-secrets.ts'

const test = Deno.test.bind(Deno)

const NOT_SEALED: Readonly<Record<string, string>> = {
  'account.password': 'Argon2id hash, not reversible',
  'account.access_token': 'always written null (login-only OAuth link)',
  'account.refresh_token': 'always written null (login-only OAuth link)',
  'account.id_token': 'always written null (login-only OAuth link)',
  'forge.webhook_token_hash': 'hash',
  'invitation.token_hash': 'hash',
  [['license', 'token'].join('.')]: 'one-way hash of the license value',
  'session.token': 'opaque session id, not a sealed envelope',
  'network.compose_key': 'compose network name, not a credential',
  'storage.compose_volume_key': 'compose volume name, not a credential',
  'server.machine_key': 'derived deterministic identifier, not sealed',
  'passkey.public_key': 'public key',
  'relay.public_key': 'public key',
  'ssh.public_key': 'public key',
  'label.key': 'label name',
  'setting.key': 'setting name',
  'variable.key': 'variable name',
}

const NAME_PATTERN = /envelope|secret|preshared|private_key|key_pem|password|token/i

function schemaColumns(): { table: string; column: string }[] {
  const out: { table: string; column: string }[] = []
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue
    const config = getTableConfig(value)
    for (const col of config.columns) {
      if (!/Text|Jsonb|Varchar/.test(col.columnType)) continue
      out.push({ table: config.name, column: col.name })
    }
  }
  return out
}

/** Columns whose own doc comment in schema.ts calls them sealed / `tpsecret`. */
function commentSealedColumns(source: string): Set<string> {
  const found = new Set<string>()
  const chunks = source.split('pgTable(')
  const columnDoc =
    /\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*\w+:\s*(?:text|jsonb|varchar)\(\s*'([^']+)'/g
  for (const chunk of chunks.slice(1)) {
    const table = /^\s*'([^']+)'/.exec(chunk)?.[1]
    if (!table) continue
    for (const match of chunk.matchAll(columnDoc)) {
      if (/tpsecret|sealed/i.test(match[1]!)) found.add(`${table}.${match[2]}`)
    }
  }
  return found
}

test('every sealed schema column is covered by the re-encrypt sweep', async () => {
  const source = await Deno.readTextFile(new URL('../db/schema.ts', import.meta.url))
  const covered = new Set<string>(REENCRYPT_COVERED_PLACES.filter((p) => !p.startsWith('setting:')))
  const columns = schemaColumns()
  const known = new Set(columns.map((c) => `${c.table}.${c.column}`))

  const candidates = new Set<string>(commentSealedColumns(source))
  for (const { table, column } of columns) {
    if (NAME_PATTERN.test(column)) candidates.add(`${table}.${column}`)
  }

  const uncovered = [...candidates].filter((c) => !covered.has(c) && !(c in NOT_SEALED)).toSorted()
  assertEquals(
    uncovered,
    [],
    'sealed column(s) missing from REENCRYPT_COVERED_PLACES (add a sweep stage) or NOT_SEALED (with a reason)'
  )

  // Stale entries: renamed or dropped columns must not linger in either list.
  const stale = [...covered, ...Object.keys(NOT_SEALED)].filter((c) => !known.has(c)).toSorted()
  assertEquals(stale, [], 'covered / exempt entries that no longer exist in the schema')

  // The comment-derived set is non-trivial, so the derivation itself is alive.
  assert(commentSealedColumns(source).size >= 5)
})
