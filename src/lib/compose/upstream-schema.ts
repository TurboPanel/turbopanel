/**
 * Stage 1 of compose validation: the **upstream Compose Specification**.
 *
 * Schema: `./vendor/compose-spec.schema.json`, a byte-identical copy of
 * `schema/compose-spec.json` from `compose-spec/compose-spec` at pinned
 * revision `4e2fe7602af8c965ab4fef891e9dde9c5940775f`. It is never fetched from
 * upstream `main` — at runtime, at build time, or in a test. See
 * `./vendor/README.md` for the refresh procedure and why the pin is load-bearing.
 *
 * This runs before the `x-turbopanel` extension schema and before the semantic
 * linter, because "is this even a Compose file" has to be answered before "does
 * TurboPanel support what it says". A document that fails here would fail for
 * `docker compose` too.
 *
 * ## A complete evaluator for the dialect the vendored schema uses
 *
 * The vendored document is JSON Schema Draft 2020-12 and uses thirteen
 * assertion keywords — `$ref`, `type`, `enum`, `properties`,
 * `patternProperties`, `additionalProperties`, `required`, `items`, `oneOf`,
 * `pattern`, `minimum`, `maximum`, `uniqueItems` — plus the annotation
 * keywords (`$schema`, `$id`, `$defs`, `title`, `description`, `default`,
 * `deprecated`). **Every one of the thirteen is evaluated here.** A general
 * validator library is not pulled in because the worker bundle carries no
 * JSON-Schema dependency and the vendored document is the only schema this
 * module ever sees; {@link IMPLEMENTED_SCHEMA_KEYWORDS} plus the keyword-sweep
 * test in `./upstream-schema.test.ts` is what keeps that claim honest — a
 * vendored refresh that introduces a fourteenth keyword fails the sweep instead
 * of silently going unchecked.
 *
 * `oneOf` is a real Draft 2020-12 `oneOf`: every branch is evaluated, exactly
 * one must match, and when none does the branch that came closest supplies the
 * diagnostics. Earlier revisions of this module discriminated branches by type
 * and never descended, which let a value that matches a branch's *type* but
 * violates its `minimum`, `pattern`, or `required` through — `oom_score_adj:
 * 2000` and a long-form `volumes:` entry with no `type:` are the two that bit.
 *
 * ## The three ergonomic exceptions, all node-scoped
 *
 * No keyword is skipped. Three *nodes* are, and each is a place where the
 * document in hand is not yet the document being asserted about:
 *
 * - **Interpolated scalars** — `container_name: "{$APP}"`, `replicas:
 *   "${COUNT}"`. The scalar stands for a value the schema cannot see, so
 *   asserting `pattern` / `enum` / `type` against the *placeholder* answers a
 *   question nobody asked. Variables are substituted in
 *   `./apply-variables.ts`, after this stage.
 * - **Empty and null values.** A half-typed `environment:` with nothing under
 *   it yet is a draft, not a violation. The editor lints on every keystroke;
 *   refusing the intermediate states of normal typing would make it useless.
 * - **Tagged subtrees.** `!reset` / `!override` are Compose overlay tags: the
 *   payload is merged elsewhere, and the merged result is validated in full at
 *   deploy time (`./validate-for-deploy.ts`).
 *
 * ## Who reports unknown keys
 *
 * At the document root and at `services.<name>` this module stays silent about
 * unknown properties, because `./field-policy.ts` + `./lint.ts` own those two
 * levels and answer with a "did you mean" suggestion and a field-state verdict
 * rather than a bare schema violation. Everywhere else (`deploy.*`,
 * `healthcheck.*`, `networks.<name>.*`, …) an unknown property is reported
 * here — one voice per path, never two.
 */

import {
  isMap,
  isSeq,
  type LineCounter,
  type Node,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml'
import schemaJson from './vendor/compose-spec.schema.json' with { type: 'json' }
import type { ComposeLintIssue } from './lint.ts'

/** The vendored Compose Specification schema, as loaded. */
const COMPOSE_SPEC_SCHEMA = schemaJson as unknown as JsonSchema

/** The pinned upstream revision the vendored copy was taken at. */
export const COMPOSE_SPEC_SCHEMA_REVISION =
  '4e2fe7602af8c965ab4fef891e9dde9c5940775f'

/**
 * Assertion keywords this module evaluates.
 *
 * The keyword sweep in `./upstream-schema.test.ts` walks the vendored document
 * and fails if it uses one that is neither here nor in
 * {@link ANNOTATION_SCHEMA_KEYWORDS}. That is the guard that makes "the
 * vendored schema is fully enforced" a checkable statement rather than a
 * comment: a refresh that pulls in `allOf`, `if`/`then`, `prefixItems`,
 * `minLength`, … fails loudly here instead of quietly validating less.
 */
export const IMPLEMENTED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  '$ref',
  'type',
  'enum',
  'properties',
  'patternProperties',
  'additionalProperties',
  'required',
  'items',
  'oneOf',
  'pattern',
  'minimum',
  'maximum',
  'uniqueItems',
])

/** Keywords that carry no assertion — nothing to evaluate, nothing to miss. */
export const ANNOTATION_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  '$id',
  '$comment',
  '$defs',
  'title',
  'description',
  'default',
  'deprecated',
  'examples',
])

type JsonSchema = {
  $ref?: string
  $defs?: Record<string, JsonSchema>
  type?: string | string[]
  enum?: unknown[]
  properties?: Record<string, JsonSchema>
  patternProperties?: Record<string, JsonSchema>
  additionalProperties?: boolean | JsonSchema
  required?: string[]
  items?: JsonSchema
  oneOf?: JsonSchema[]
  pattern?: string
  minimum?: number
  maximum?: number
  uniqueItems?: boolean
}

/** JSON Schema type names, as the vendored document spells them. */
type JsonTypeName =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null'

/**
 * Resolve a local `#/$defs/<name>` pointer against the vendored root.
 *
 * Only local pointers exist in this schema; a remote `$ref` would be a fetch,
 * which this module does not do.
 */
function resolveRef(schema: JsonSchema): JsonSchema {
  let current = schema
  // Bounded: a `$ref` chain in a hand-written schema is one or two hops, and a
  // cycle here would otherwise hang the linter on every keystroke.
  for (let hop = 0; hop < 8; hop += 1) {
    const ref = current.$ref
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return current
    let target: unknown = COMPOSE_SPEC_SCHEMA
    for (const rawSegment of ref.slice(2).split('/')) {
      const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~')
      if (typeof target !== 'object' || target === null) return current
      target = (target as Record<string, unknown>)[segment]
    }
    if (typeof target !== 'object' || target === null) return current
    current = target as JsonSchema
  }
  return current
}

/** True when the node carries a Compose overlay tag (`!reset` / `!override`). */
function isTaggedNode(node: Node | null | undefined): boolean {
  if (!node || typeof node !== 'object') return false
  const tag = (node as { tag?: string }).tag
  return tag === '!reset' || tag === '!override'
}

function scalarValue(node: Node): unknown {
  return (node as Scalar).value
}

/**
 * True when the node is a not-yet-filled-in value: `key:` with nothing after
 * it, or an empty string. Skipped rather than validated — see the module note
 * on drafts.
 */
function isBlankNode(node: Node | null | undefined): boolean {
  if (node === null || node === undefined) return true
  if (isMap(node) || isSeq(node)) return false
  if (!('value' in (node as object))) return true
  const value = scalarValue(node)
  if (value === null || value === undefined) return true
  return typeof value === 'string' && value.trim().length === 0
}

/**
 * True when a scalar string carries a variable reference — `${DOCKER_STYLE}` or
 * TurboPanel's `{$KEY}`. Such a value is a placeholder for something the schema
 * cannot see, so every value assertion stands down for it.
 */
function isInterpolated(node: Node): boolean {
  const value = scalarValue(node)
  if (typeof value !== 'string') return false
  return value.includes('${') || value.includes('{$')
}

/** JSON type of a YAML node, or `null` when it is not a value we classify. */
function jsonTypeOf(node: Node): JsonTypeName | null {
  if (isMap(node)) return 'object'
  if (isSeq(node)) return 'array'
  if (!('value' in (node as object))) return null
  const value = scalarValue(node)
  if (value === null) return 'null'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return null
}

/** JSON Schema's number/integer relationship: every integer is a number. */
function typeAccepts(expected: string, actual: JsonTypeName): boolean {
  if (expected === actual) return true
  return expected === 'number' && actual === 'integer'
}

function schemaTypes(schema: JsonSchema): string[] | null {
  const type = schema.type
  if (typeof type === 'string') return [type]
  if (Array.isArray(type)) return type
  return null
}

function nodeLine(
  node: Node | null | undefined,
  lineCounter: LineCounter,
): number | undefined {
  const range = (node as { range?: [number, number, number] } | null)?.range
  if (!range) return undefined
  return lineCounter.linePos(range[0]).line
}

function stringKey(key: unknown): string | null {
  if (key && typeof key === 'object' && 'value' in (key as object)) {
    const value = (key as { value: unknown }).value
    if (typeof value === 'string') return value
  }
  return null
}

/**
 * The two levels whose unknown keys `./lint.ts` reports (with a suggestion and
 * a field-state verdict). Everything else is this module's to report.
 */
function ownedByFieldPolicy(path: string): boolean {
  return path === '' || /^services\.[^.]+$/.test(path)
}

type SchemaContext = {
  lineCounter: LineCounter
  issues: ComposeLintIssue[]
}

/** A throwaway collector for one `oneOf` branch; see {@link checkOneOf}. */
function branchContext(context: SchemaContext): SchemaContext {
  return { lineCounter: context.lineCounter, issues: [] }
}

/** Last path segment, quoted, for a message that has to read on its own. */
function pathLabel(path: string): string {
  if (path === '') return 'The compose document'
  const segment = path.split('.').pop() ?? path
  return `"${segment}"`
}

function pushIssue(
  context: SchemaContext,
  path: string,
  node: Node | null | undefined,
  message: string,
): void {
  context.issues.push({
    level: 'error',
    message,
    path: path || '$',
    line: nodeLine(node, context.lineCounter),
  })
}

function checkType(
  node: Node,
  schema: JsonSchema,
  path: string,
  context: SchemaContext,
): boolean {
  const expected = schemaTypes(schema)
  if (!expected) return true
  const actual = jsonTypeOf(node)
  if (actual === null) return true
  if (expected.some((candidate) => typeAccepts(candidate, actual))) return true
  pushIssue(
    context,
    path,
    node,
    `${pathLabel(path)} must be ${
      expected.join(' or ')
    } per the Compose Specification, got ${actual}`,
  )
  return false
}

function checkEnum(
  node: Node,
  schema: JsonSchema,
  path: string,
  context: SchemaContext,
): void {
  const allowed = schema.enum
  if (!Array.isArray(allowed) || isMap(node) || isSeq(node)) return
  const value = scalarValue(node)
  if (allowed.includes(value)) return
  pushIssue(
    context,
    path,
    node,
    `${pathLabel(path)} must be one of ${
      allowed.map(String).join(', ')
    } per the Compose Specification`,
  )
}

/**
 * `pattern` — an unanchored ECMA-262 match, per Draft 2020-12, against string
 * values only. Interpolated scalars never reach here (see {@link validateNode});
 * that is the whole of the interpolation carve-out, and it is one node test
 * rather than a disabled keyword.
 */
function checkPattern(
  node: Node,
  schema: JsonSchema,
  path: string,
  context: SchemaContext,
): void {
  const pattern = schema.pattern
  if (typeof pattern !== 'string' || isMap(node) || isSeq(node)) return
  const value = scalarValue(node)
  if (typeof value !== 'string') return
  let regex: RegExp
  try {
    regex = new RegExp(pattern, 'u')
  } catch {
    // A pattern this runtime cannot compile is a vendored-schema problem, not
    // an author's; staying silent beats refusing a document over it.
    return
  }
  if (regex.test(value)) return
  pushIssue(
    context,
    path,
    node,
    `${pathLabel(path)} must match ${pattern} per the Compose Specification`,
  )
}

/** `minimum` / `maximum` — inclusive bounds on numeric values. */
function checkBounds(
  node: Node,
  schema: JsonSchema,
  path: string,
  context: SchemaContext,
): void {
  if (schema.minimum === undefined && schema.maximum === undefined) return
  if (isMap(node) || isSeq(node)) return
  const value = scalarValue(node)
  if (typeof value !== 'number' || !Number.isFinite(value)) return
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    pushIssue(
      context,
      path,
      node,
      `${pathLabel(path)} must be >= ${schema.minimum} per the Compose Specification, got ${value}`,
    )
    return
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    pushIssue(
      context,
      path,
      node,
      `${pathLabel(path)} must be <= ${schema.maximum} per the Compose Specification, got ${value}`,
    )
  }
}

/**
 * Structural identity of one sequence entry, for {@link checkUniqueItems}.
 *
 * `null` means "cannot be compared" and the entry is skipped rather than
 * treated as equal to every other unreadable entry — an uncomparable node must
 * never manufacture a duplicate.
 */
function itemIdentity(node: unknown): string | null {
  const toJSON = (node as { toJSON?: () => unknown })?.toJSON
  if (typeof toJSON !== 'function') return null
  try {
    return JSON.stringify(toJSON.call(node)) ?? null
  } catch {
    return null
  }
}

function checkUniqueItems(
  node: YAMLSeq,
  schema: JsonSchema,
  path: string,
  context: SchemaContext,
): void {
  if (schema.uniqueItems !== true) return
  const seen = new Set<string>()
  for (const [index, item] of node.items.entries()) {
    // A not-yet-filled-in entry is a draft, not a duplicate.
    if (isBlankNode(item as Node | null | undefined)) continue
    const identity = itemIdentity(item)
    if (identity === null) continue
    if (!seen.has(identity)) {
      seen.add(identity)
      continue
    }
    pushIssue(
      context,
      `${path}[${index}]`,
      item as Node,
      `${pathLabel(path)} entries must be unique per the Compose Specification`,
    )
  }
}

/**
 * True when a branch's `type` could describe this node at all.
 *
 * The tie-breaker for {@link checkOneOf}'s diagnostics: of the branches that
 * rejected the value, the ones whose declared type matches what the author
 * actually wrote are the ones whose complaint is about *this* value rather than
 * about it being the wrong kind of thing. `oom_score_adj: 2000` should read
 * "must be <= 1000", not "must be string".
 */
function branchTypeCouldMatch(node: Node, branch: JsonSchema): boolean {
  const expected = schemaTypes(branch)
  if (!expected) return true
  const actual = jsonTypeOf(node)
  if (actual === null) return true
  return expected.some((candidate) => typeAccepts(candidate, actual))
}

/**
 * `oneOf` — a real Draft 2020-12 `oneOf`: every branch is evaluated in its own
 * collector and exactly one has to match.
 *
 * When none matches, the branch that came closest supplies the diagnostics —
 * "long-form volume entry is missing required key \"type\"" reads as an
 * instruction, where "does not match any allowed shape" reads as a shrug.
 * Closest means: a branch whose type could describe the value beats one whose
 * type could not, and within that, fewer diagnostics wins. The fallback message
 * only fires for a union with no branches at all, since a branch that produced
 * no diagnostics is by definition a match.
 */
function checkOneOf(
  node: Node,
  branches: JsonSchema[],
  path: string,
  context: SchemaContext,
): void {
  let matched = 0
  let closest: ComposeLintIssue[] | null = null
  let closestTyped = false
  for (const rawBranch of branches) {
    const branch = resolveRef(rawBranch)
    const sub = branchContext(context)
    applySchema(node, branch, path, sub)
    if (sub.issues.length === 0) {
      matched += 1
      continue
    }
    const typed = branchTypeCouldMatch(node, branch)
    const better = closest === null ||
      (typed && !closestTyped) ||
      (typed === closestTyped && sub.issues.length < closest.length)
    if (better) {
      closest = sub.issues
      closestTyped = typed
    }
  }
  if (matched === 1) return
  if (matched > 1) {
    pushIssue(
      context,
      path,
      node,
      `${pathLabel(path)} matches more than one allowed shape in the Compose Specification`,
    )
    return
  }
  if (closest && closest.length > 0) {
    for (const issue of closest) context.issues.push(issue)
    return
  }
  pushIssue(
    context,
    path,
    node,
    `${pathLabel(path)} does not match any shape the Compose Specification allows`,
  )
}

/** Sub-schema for `key` within an object schema, plus whether it was known. */
function propertySchemaFor(
  schema: JsonSchema,
  key: string,
): { schema: JsonSchema | null; known: boolean } {
  const direct = schema.properties?.[key]
  if (direct) return { schema: direct, known: true }
  for (const [pattern, sub] of Object.entries(schema.patternProperties ?? {})) {
    if (new RegExp(pattern).test(key)) return { schema: sub, known: true }
  }
  const additional = schema.additionalProperties
  if (additional === false) return { schema: null, known: false }
  if (additional && typeof additional === 'object') {
    return { schema: additional, known: true }
  }
  return { schema: null, known: true }
}

function checkRequired(
  node: YAMLMap,
  schema: JsonSchema,
  path: string,
  context: SchemaContext,
): void {
  const required = schema.required
  if (!Array.isArray(required) || required.length === 0) return
  const present = new Set<string>()
  for (const item of node.items) {
    const key = stringKey(item.key)
    if (key !== null) present.add(key)
  }
  for (const key of required) {
    if (present.has(key)) continue
    pushIssue(
      context,
      path,
      node,
      `${pathLabel(path)} is missing required key "${key}"`,
    )
  }
}

function pushUnknownKeyIssue(
  key: string,
  keyNode: Node,
  path: string,
  childPath: string,
  context: SchemaContext,
): void {
  const container = path === '' ? 'the compose document' : `"${path}"`
  pushIssue(
    context,
    childPath,
    keyNode,
    `Unknown key "${key}" in ${container} — not part of the Compose Specification`,
  )
}

function validateObject(
  node: YAMLMap,
  schema: JsonSchema,
  path: string,
  context: SchemaContext,
): void {
  checkRequired(node, schema, path, context)
  const reportUnknown = !ownedByFieldPolicy(path)
  for (const item of node.items) {
    const key = stringKey(item.key)
    if (key === null) continue
    const childPath = path ? `${path}.${key}` : key
    const resolved = propertySchemaFor(schema, key)
    if (!resolved.known) {
      if (reportUnknown) {
        pushUnknownKeyIssue(key, item.key as Node, path, childPath, context)
      }
      continue
    }
    if (!resolved.schema) continue
    validateNode(
      item.value as Node | null | undefined,
      resolved.schema,
      childPath,
      context,
    )
  }
}

function validateArray(
  node: YAMLSeq,
  schema: JsonSchema,
  path: string,
  context: SchemaContext,
): void {
  const items = schema.items
  if (!items) return
  for (const [index, item] of node.items.entries()) {
    validateNode(item as Node | null | undefined, items, `${path}[${index}]`, context)
  }
}

/**
 * Apply every assertion keyword in one (already `$ref`-resolved) schema to one
 * node that has already passed the node-level skips in {@link validateNode}.
 *
 * Split out from `validateNode` because `oneOf` branches re-enter *here*: the
 * skips are a property of the node, not of the branch, and re-running them per
 * branch would let a branch quietly opt out of being evaluated.
 */
function applySchema(
  node: Node,
  schema: JsonSchema,
  path: string,
  context: SchemaContext,
): void {
  if (Array.isArray(schema.oneOf)) {
    checkOneOf(node, schema.oneOf, path, context)
  }
  if (!checkType(node, schema, path, context)) return
  checkEnum(node, schema, path, context)
  checkPattern(node, schema, path, context)
  checkBounds(node, schema, path, context)

  if (isMap(node)) {
    validateObject(node as YAMLMap, schema, path, context)
    return
  }
  if (isSeq(node)) {
    checkUniqueItems(node as YAMLSeq, schema, path, context)
    validateArray(node as YAMLSeq, schema, path, context)
  }
}

function validateNode(
  node: Node | null | undefined,
  rawSchema: JsonSchema,
  path: string,
  context: SchemaContext,
): void {
  if (isTaggedNode(node) || isBlankNode(node)) return
  const value = node as Node
  // An interpolated scalar stands for a value the schema cannot see.
  if (!isMap(value) && !isSeq(value) && isInterpolated(value)) return
  applySchema(value, resolveRef(rawSchema), path, context)
}

/**
 * Validate a parsed compose root against the vendored Compose Specification.
 *
 * Returns blocking {@link ComposeLintIssue}s — the same shape every other
 * validation stage produces, so callers never grow a second issue type and the
 * editor renders schema errors through the diagnostics path it already has.
 */
export function validateAgainstUpstreamSchema(
  root: YAMLMap,
  lineCounter: LineCounter,
): ComposeLintIssue[] {
  const context: SchemaContext = { lineCounter, issues: [] }
  validateObject(root, COMPOSE_SPEC_SCHEMA, '', context)
  return context.issues
}
