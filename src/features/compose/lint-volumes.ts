import { isMap, type LineCounter, type Node, type YAMLMap } from 'yaml'
import type { ComposeLintIssue } from './lint.ts'

function nodeLine(node: Node, lineCounter: LineCounter): number | undefined {
  const range = (node as { range?: [number, number, number] }).range
  return range ? lineCounter.linePos(range[0]).line : undefined
}

function stringKey(key: unknown): string | null {
  const value = (key as { value?: unknown } | null)?.value
  return typeof value === 'string' ? value : null
}

/** True when the node carries Compose Spec `!reset` / `!override`. */
function isTaggedNode(node: Node | null | undefined): boolean {
  const tag = (node as { tag?: string } | null | undefined)?.tag
  return tag === '!reset' || tag === '!override'
}

/**
 * Refuse an author-declared `external` top-level volume. TurboPanel owns the
 * names of the volumes it creates; a volume the author points at by name
 * would be registered as the environment's own storage and sent to the host
 * under a name the author chose. Declare the volume without `external` and
 * the platform provisions it.
 */
function isExternalDeclared(field: { value?: unknown }): boolean {
  const value = field.value as { value?: unknown } | null | undefined
  if (!value || !('value' in value)) return true
  return value.value !== false && value.value !== null
}

function lintVolumeEntry(
  key: string,
  entry: Node | null | undefined,
  strict: boolean,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[]
): void {
  if (!isMap(entry) || isTaggedNode(entry)) return
  for (const field of (entry as YAMLMap).items) {
    if (stringKey(field.key) !== 'external' || !isExternalDeclared(field)) continue
    issues.push({
      level: strict ? 'error' : 'warning',
      code: 'field_unsupported',
      message:
        `volumes.${key}.external is not supported: TurboPanel creates and names the ` +
        `volumes of an environment itself. Remove \`external\` and let the platform provision "${key}".`,
      path: `volumes.${key}.external`,
      line: nodeLine(field.key as Node, lineCounter),
      // Save-time keeps a draft editable; deploy-time refuses it.
      ...(strict ? {} : { blocking: false as const }),
    })
  }
}

export function lintVolumes(
  volumesNode: Node | null | undefined,
  strict: boolean,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[]
): void {
  if (!isMap(volumesNode) || isTaggedNode(volumesNode)) return
  for (const item of (volumesNode as YAMLMap).items) {
    const key = stringKey(item.key)
    if (key === null || key.startsWith('x-')) continue
    lintVolumeEntry(key, item.value as Node | null | undefined, strict, lineCounter, issues)
  }
}
