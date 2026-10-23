/**
 * Words for `project.kind` and `project.icon`. `schema.ts` carries the same
 * lists as CHECK constraints; `enum-checks.test.ts` pins them together.
 */

/**
 * What a project is. `compose` covers a hand-written compose project and a
 * template project (a template is compose plus `metadata.code`); `managed` is a
 * managed database or service; `system` is platform-owned and never accepted
 * from the API. NULL means a draft that has not chosen yet.
 */
export const PROJECT_KINDS = ['compose', 'managed', 'system'] as const

export type ProjectKind = (typeof PROJECT_KINDS)[number]

/**
 * The fixed list of icon keys the project screens offer. A managed project
 * ignores its stored icon and always shows the managed icon.
 */
export const PROJECT_ICONS = [
  'cube',
  'globe',
  'cart',
  'bolt',
  'chat',
  'chart',
  'code',
  'book',
  'layers',
  'mail',
  'rocket',
  'image',
] as const

export type ProjectIcon = (typeof PROJECT_ICONS)[number]

export function isProjectIcon(value: unknown): value is ProjectIcon {
  return typeof value === 'string' && (PROJECT_ICONS as readonly string[]).includes(value)
}

/** The stored kind for a project type named in a create or configure request. */
export function projectKindForType(type: 'docker-compose' | 'template' | 'managed'): ProjectKind {
  return type === 'managed' ? 'managed' : 'compose'
}
