/**
 * Static gate over every path that can send SQL to Cloudflare Analytics
 * Engine. `sql-limits.test.ts` holds the statements to the AE dialect for the
 * worst-case request of each exported query helper; this suite makes sure a
 * NEW helper (or a second way to reach the SQL endpoint) cannot ship without
 * being added there. Every AE `422` seen on testing on 2026-09-27 came from a
 * builder that no dialect test exercised.
 */
import { assert, assertEquals } from '@std/assert'
import { fromFileUrl } from '@std/path'

/** Jest/Mocha-shaped alias for {@link Deno.test} (Sonar typescript:S2187). */
const test = Deno.test.bind(Deno)

const HERE = fromFileUrl(new URL('.', import.meta.url))
const SRC = fromFileUrl(new URL('../../../../', import.meta.url))

/** Every non-test `.ts` file under `dir`. */
async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}${dir.endsWith('/') ? '' : '/'}${entry.name}`
    if (entry.isDirectory) {
      if (entry.name !== 'node_modules') out.push(...(await sourceFiles(path)))
    } else if (entry.isFile && path.endsWith('.ts') && !path.endsWith('.test.ts')) {
      out.push(path)
    }
  }
  return out
}

async function read(name: string): Promise<string> {
  return await Deno.readTextFile(`${HERE}${name}`)
}

test('every exported AE query helper is exercised by the dialect gate', async () => {
  const api = await read('sql-api.ts')
  const gate = await read('sql-limits.test.ts')
  const helpers = [...api.matchAll(/^export async function (query\w+)\s*\(/gm)].map((m) => m[1])
  assert(helpers.length >= 8, `found only ${helpers.length} query helpers`)
  const missing = helpers.filter((name) => !new RegExp(`\\b${name}\\(`).test(gate))
  assertEquals(
    missing,
    [],
    'add a worst-case capturing test for these helpers to sql-limits.test.ts'
  )
})

test('only sql-api.ts talks to the AE SQL endpoint, through one fetch', async () => {
  const offenders: string[] = []
  for (const path of await sourceFiles(SRC)) {
    const text = await Deno.readTextFile(path)
    if (text.includes('analytics_engine/sql') && !path.endsWith('/cloudflare/sql-api.ts')) {
      offenders.push(path.slice(SRC.length))
    }
  }
  assertEquals(offenders, [])

  const api = await read('sql-api.ts')
  // executeSql is the one place a statement leaves the process; it enforces
  // the length limit and names the builder in its errors.
  assertEquals([...api.matchAll(/\bfetchFn\(/g)].length, 1)
  assertEquals([...api.matchAll(/(?<![\w.])fetch\(/g)].length, 0)
})
