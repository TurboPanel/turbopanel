/**
 * Words for `project.kind` and `project.icon`. `schema.ts` carries the same
 * lists as CHECK constraints (the icon one also allows one emoji); `enum-checks.test.ts` pins them together.
 */
import { ICON_KEYS, type IconKey, isIconKey } from '../../lib/icons.ts'

/**
 * What a project is. `compose` covers a hand-written compose project and a
 * template project (a template is compose plus `metadata.code`); `managed` is a
 * managed database or service; `system` is platform-owned and never accepted
 * from the API. NULL means a draft that has not chosen yet.
 */
export const PROJECT_KINDS = ['compose', 'managed', 'system'] as const

export type ProjectKind = (typeof PROJECT_KINDS)[number]

/**
 * The fixed list of icon keys the project screens offer (the same list
 * organizations use, from `lib/icons.ts`). A project icon may also be one
 * emoji. A managed project ignores its stored icon and always shows the
 * managed icon.
 */
export const PROJECT_ICONS = ICON_KEYS

export type ProjectIcon = IconKey

export function isProjectIcon(value: unknown): value is ProjectIcon {
  return isIconKey(value)
}

/** The stored kind for a project type named in a create or configure request. */
export function projectKindForType(type: 'docker-compose' | 'template' | 'managed'): ProjectKind {
  return type === 'managed' ? 'managed' : 'compose'
}
