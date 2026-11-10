/**
 * Negative coverage for the expand-only field snapshot. A narrowed union,
 * literal, array, or member must fail even when the field name and `?`
 * marker are unchanged.
 */
import { assertEquals, assertStringIncludes, assertThrows } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'
import {
  extractFieldSpecs,
  fieldPinDrift,
  mapDriftFromDaemon,
  mirrorDrift,
  missingFromDaemon,
  objectLiteralEntries,
  snapshotDataDrift,
  snapshotSubsetDrift,
} from './check-contract-drift.mjs'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), '..')

const NARROWED = `
export type Scope = "private" | "public";
export type Sample = {
  /** brace } inside a comment must not end the object */
  address: "only";
  version: 4;
  items: Array<string>;
  payload: {
    id: string;
    name: string;
  };
};
`

type FieldPin = {
  name: string
  required: boolean
  type: string
  expansion?: boolean
}

const PIN: FieldPin[] = [
  { name: 'address', required: true, type: 'string' },
  { name: 'version', required: true, type: '4 | 6' },
  { name: 'items', required: true, type: 'Array<string | number>' },
  {
    name: 'payload',
    required: true,
    type: '{ id: string; name: string | number }',
  },
]

test('extractFieldSpecs keeps fields after a brace inside a comment', () => {
  const live = extractFieldSpecs(NARROWED, 'Sample')
  assertEquals(
    live?.map((field: { name: string }) => field.name),
    ['address', 'items', 'payload', 'version']
  )
})

test('a narrowed union, literal, array, or member fails the drift check', () => {
  const live = extractFieldSpecs(NARROWED, 'Sample')
  assertStringIncludes(fieldPinDrift(live, [PIN[1]], 'fixture') ?? '', 'narrowed version')
  assertStringIncludes(fieldPinDrift(live, [PIN[0]], 'fixture') ?? '', 'narrowed address')
  assertStringIncludes(fieldPinDrift(live, [PIN[2]], 'fixture') ?? '', 'narrowed items')
  assertStringIncludes(fieldPinDrift(live, [PIN[3]], 'fixture') ?? '', 'narrowed payload')
})

test('a wider type passes only when the snapshot marks a compatible expansion', () => {
  const live = extractFieldSpecs('export type Sample = { version: 4 | 6 | 8 };', 'Sample')
  const pin: FieldPin = {
    name: 'version',
    required: true,
    type: '4 | 6',
  }
  assertStringIncludes(
    fieldPinDrift(live, [pin], 'fixture') ?? '',
    'without a compatible expansion mark'
  )
  assertEquals(fieldPinDrift(live, [{ ...pin, expansion: true }], 'fixture'), null)
  const narrowed = extractFieldSpecs('export type Sample = { version: 4 };', 'Sample')
  assertStringIncludes(
    fieldPinDrift(narrowed, [{ ...pin, expansion: true }], 'fixture') ?? '',
    'narrowed version'
  )
})

test("the committed snapshot matches both checkouts' normalized field types", async () => {
  const sibling = join(repoRoot, '..', 'turbopaneld')
  try {
    await Deno.stat(sibling)
  } catch {
    // CI's deno db shards check this repo out alone; contract-twin dual-checkout
    // still runs the sibling assert via check-contract-drift.mjs.
    return
  }
  const snapshot = JSON.parse(
    await Deno.readTextFile(join(repoRoot, 'scripts/contract-field-snapshot.json'))
  ) as Record<string, { instance: string; daemon: string; fields: FieldPin[] }>
  for (const [typeName, pin] of Object.entries(snapshot)) {
    const instanceSrc = await Deno.readTextFile(join(repoRoot, pin.instance))
    assertEquals(extractFieldSpecs(instanceSrc, typeName), pin.fields)
    // Daemon first: the daemon's own snapshot may pin more (optional) fields.
    const daemonSnapshot = JSON.parse(
      await Deno.readTextFile(join(sibling, 'scripts/contract-field-snapshot.json'))
    ) as Record<string, { daemon: string; fields: FieldPin[] }>
    const daemonSrc = await Deno.readTextFile(join(sibling, daemonSnapshot[typeName].daemon))
    assertEquals(
      fieldPinDrift(
        extractFieldSpecs(daemonSrc, typeName),
        daemonSnapshot[typeName].fields,
        'daemon'
      ),
      null
    )
  }
})

test('snapshotDataDrift ignores layout and names the first differing path', () => {
  const wrapped = `{
  "Foo": {
    "fields": [
      {
        "name": "type",
        "required": true
      }
    ]
  }
}`
  const collapsed = `{"Foo": {"fields": [{ "name": "type", "required": true }]}}`
  assertEquals(snapshotDataDrift(wrapped, collapsed), null)
  assertEquals(
    snapshotDataDrift(wrapped, collapsed.replace('"required": true', '"required": false')),
    '$.Foo.fields[0].required'
  )
  assertEquals(snapshotDataDrift(wrapped, `{"Foo": {"fields": []}}`), '$.Foo.fields[0]')
  assertEquals(snapshotDataDrift(wrapped, `{"Bar": {}}`), '$.Foo')
})

test('snapshotDataDrift reports a shorter array and a malformed file', () => {
  assertEquals(snapshotDataDrift(`{"a": [1, 2]}`, `{"a": [1]}`), '$.a[1]')
  assertEquals(snapshotDataDrift(`{"a": 1, "b": 2}`, `{"b": 2, "a": 1}`), null)
  assertThrows(
    () => snapshotDataDrift(`{"a": `, `{}`),
    Error,
    'contract-field-snapshot.json on the instance is not valid JSON'
  )
  assertThrows(() => snapshotDataDrift(`{}`, `nope`), Error, 'on the daemon is not valid JSON')
})

// Daemon first: the daemon may be ahead of the control plane, never behind.
test('a daemon with more wire features passes; a control plane with one daemon lacks names it', () => {
  assertEquals(missingFromDaemon(['a-v1'], ['a-v1', 'b-v1']), [])
  assertEquals(missingFromDaemon(['a-v1', 'c-v1'], ['a-v1']), ['c-v1'])
})

test('feature floors: every control plane key must be on the daemon with the same value', () => {
  assertEquals(objectLiteralEntries('{ a: 0.1.1, b: 0.2.0, }'), [
    ['a', '0.1.1'],
    ['b', '0.2.0'],
  ])
  assertEquals(objectLiteralEntries('{}'), [])
  assertEquals(objectLiteralEntries('{ nope }'), null)
  assertEquals(mapDriftFromDaemon('{ a: 0.1.1 }', '{ a: 0.1.1, b: 0.2.0 }'), null)
  assertEquals(mapDriftFromDaemon('{}', '{ b: 0.2.0 }'), null)
  assertStringIncludes(
    mapDriftFromDaemon('{ c: 0.3.0 }', '{ a: 0.1.1 }') ?? '',
    'c is not in daemon trunk'
  )
  assertStringIncludes(
    mapDriftFromDaemon('{ a: 0.1.2 }', '{ a: 0.1.1 }') ?? '',
    'a is 0.1.2 here but 0.1.1 on daemon trunk'
  )
  assertStringIncludes(mapDriftFromDaemon(null, '{}') ?? '', 'missing')
})

test('snapshot: the daemon may pin more types and optional fields, never fewer or different', () => {
  const pin = (fields: FieldPin[]) =>
    JSON.stringify({ T: { instance: 'i.ts', daemon: 'd.ts', fields } })
  const a: FieldPin = { name: 'a', required: true, type: 'string' }
  const b: FieldPin = { name: 'b', required: false, type: 'number' }
  assertEquals(snapshotSubsetDrift(pin([a]), pin([a, b])), null)
  assertEquals(
    snapshotSubsetDrift(
      pin([a]),
      JSON.stringify({ ...JSON.parse(pin([a])), U: { instance: 'x', daemon: 'y', fields: [] } })
    ),
    null
  )
  assertStringIncludes(snapshotSubsetDrift(pin([a, b]), pin([a])) ?? '', 'T.b is pinned here')
  assertStringIncludes(snapshotSubsetDrift(pin([a]), '{}') ?? '', 'T is pinned here')
  assertStringIncludes(
    snapshotSubsetDrift(pin([a]), pin([a, { ...b, required: true }])) ?? '',
    'must be optional'
  )
  assertStringIncludes(
    snapshotSubsetDrift(pin([a]), pin([{ ...a, type: 'number' }])) ?? '',
    '$.T.fields.a.type differs'
  )
  assertStringIncludes(
    snapshotSubsetDrift(
      pin([a]),
      JSON.stringify({ T: { instance: 'i.ts', daemon: 'other.ts', fields: [a] } })
    ) ?? '',
    '$.T.daemon differs'
  )
})

test('a byte mirror that differs is a notice, and red only when this pull request changes its copy', () => {
  const none = { all: false, files: new Set<string>() }
  assertEquals(mirrorDrift('X drifted', 'src/x.ts', none), false)
  assertEquals(
    mirrorDrift('X drifted', 'src/x.ts', { all: false, files: new Set(['src/other.ts']) }),
    false
  )
  assertThrows(
    () => mirrorDrift('X drifted', 'src/x.ts', { all: false, files: new Set(['src/x.ts']) }),
    Error,
    'this pull request changes src/x.ts'
  )
  assertThrows(
    () => mirrorDrift('X drifted', 'src/x.ts', { all: true, files: new Set(['*']) }),
    Error,
    'must match daemon trunk'
  )
})
