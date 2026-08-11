/**
 * JSON-safe Compose Spec `!reset` / `!override` sentinels.
 *
 * Stored compose lives in Postgres jsonb, so tags cannot remain as bare YAML
 * node metadata. On parse they become {@link ComposeTaggedValue} mappings under
 * the reserved {@link COMPOSE_TAG_KEY}; on stringify a retag pass restores
 * `!reset` / `!override` before presentation is applied.
 *
 * yaml's schema resolves tags **per node kind** (scalar / map / seq). Without
 * one entry per kind × tag, only the first matching form parses and the rest
 * surface as unresolved-tag warnings.
 */

import type { CollectionTag, ScalarTag, SchemaOptions } from 'yaml'

/** Reserved sentinel key — unlikely to appear in authored compose. */
export const COMPOSE_TAG_KEY = '__turbopanelComposeTag'

export type ComposeTagName = 'reset' | 'override'

export type ComposeTaggedValue = {
  [COMPOSE_TAG_KEY]: ComposeTagName
  value: unknown
}

export function isComposeTaggedValue(value: unknown): value is ComposeTaggedValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  if (!('value' in record)) return false
  return record[COMPOSE_TAG_KEY] === 'reset' || record[COMPOSE_TAG_KEY] === 'override'
}

export function composeTagOf(value: unknown): ComposeTagName | null {
  if (!isComposeTaggedValue(value)) return null
  return value[COMPOSE_TAG_KEY]
}

export function unwrapComposeTag(value: unknown): unknown {
  if (!isComposeTaggedValue(value)) return value
  return value.value
}

export function makeComposeTag(
  tag: ComposeTagName,
  value: unknown,
): ComposeTaggedValue {
  return { [COMPOSE_TAG_KEY]: tag, value }
}

/**
 * Recursively unwrap every tag sentinel to its plain value.
 * Used where tags have no effect (e.g. the base / first layer).
 */
export function resolveComposeTags(value: unknown): unknown {
  if (isComposeTaggedValue(value)) {
    return resolveComposeTags(value.value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveComposeTags(item))
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = resolveComposeTags(child)
    }
    return out
  }
  return value
}

/** Parse scalar tag body (`null` / `~` / empty → JS null). */
function resolveScalarTagBody(raw: string): unknown {
  if (raw === '' || raw === 'null' || raw === 'NULL' || raw === 'Null' || raw === '~') {
    return null
  }
  if (raw === 'true' || raw === 'True' || raw === 'TRUE') return true
  if (raw === 'false' || raw === 'False' || raw === 'FALSE') return false
  return raw
}

function scalarTag(name: ComposeTagName): ScalarTag {
  return {
    tag: `!${name}`,
    resolve(value: string) {
      return makeComposeTag(name, resolveScalarTagBody(value))
    },
  }
}

function mapTag(name: ComposeTagName): CollectionTag {
  return {
    tag: `!${name}`,
    collection: 'map',
    resolve(map) {
      return makeComposeTag(name, map?.toJSON?.() ?? {})
    },
  }
}

function seqTag(name: ComposeTagName): CollectionTag {
  return {
    tag: `!${name}`,
    collection: 'seq',
    resolve(seq) {
      return makeComposeTag(name, seq?.toJSON?.() ?? [])
    },
  }
}

/**
 * One entry per (tag × node kind). yaml selects tags by kind at parse time; a
 * single `!reset` entry would only cover scalers and leave map/seq untagged.
 */
export const COMPOSE_CUSTOM_TAGS: Array<ScalarTag | CollectionTag> = [
  scalarTag('reset'),
  mapTag('reset'),
  seqTag('reset'),
  scalarTag('override'),
  mapTag('override'),
  seqTag('override'),
]

/** Shared parse/stringify schema options for every compose YAML site. */
export const COMPOSE_YAML_OPTIONS: SchemaOptions = {
  customTags: COMPOSE_CUSTOM_TAGS,
}
