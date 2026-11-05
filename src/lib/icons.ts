/**
 * Icons for projects and organizations: a key from the fixed list the screens
 * offer, or one emoji. `schema.ts` carries the key list in the
 * `project_icon_check` and `organization_icon_check` constraints;
 * `enum-checks.test.ts` pins them together.
 *
 * The database only checks the rough shape of an emoji (no ASCII, at most 16
 * characters); {@link isEmojiIcon} is the exact rule every write goes through.
 * Pure code with no I/O, so it runs on Workers and Deno alike.
 */

/** The fixed list of icon keys. Always allowed, whatever the organization says about emoji. */
export const ICON_KEYS = [
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

export type IconKey = (typeof ICON_KEYS)[number]

/** Longest emoji icon, in UTF-16 code units (a family or a flag with modifiers fits). */
export const EMOJI_ICON_MAX_LENGTH = 16

export function isIconKey(value: unknown): value is IconKey {
  return typeof value === 'string' && (ICON_KEYS as readonly string[]).includes(value)
}

const ASCII = /\p{ASCII}/u
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u
const FLAG = /^\p{Regional_Indicator}{2}$/u
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' })

/**
 * True for exactly one emoji: no ASCII at all, at most
 * {@link EMOJI_ICON_MAX_LENGTH} UTF-16 units, one grapheme, and that grapheme
 * is a pictograph (with any skin tone, joiner sequence or variation selector)
 * or a flag made of two regional indicators. A keycap such as `1️⃣` starts with
 * an ASCII digit, so it is refused.
 */
export function isEmojiIcon(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > EMOJI_ICON_MAX_LENGTH) return false
  if (ASCII.test(value)) return false
  const segments = [...graphemes.segment(value)]
  if (segments.length !== 1) return false
  return PICTOGRAPHIC.test(value) || FLAG.test(value)
}

/** The error code of a refused emoji icon (HTTP 422). */
export const EMOJI_ICONS_OFF_ERROR = 'emoji_icons_off'

/** The body a route answers when an organization has emoji icons turned off. */
export const EMOJI_ICONS_OFF_BODY = {
  error: EMOJI_ICONS_OFF_ERROR,
  message: 'This organization has emoji icons turned off. Pick one of the regular icons.',
} as const

/**
 * An optional `icon` field of a request body: a key, one emoji, or null for
 * the default. `undefined` means the caller did not mention it. `emoji` says
 * whether the accepted value is an emoji, so the route can check the
 * organization's setting.
 */
export function parseIconValue(
  icon: unknown
): { ok: true; icon: string | null | undefined; emoji: boolean } | { ok: false } {
  if (icon === undefined || icon === null) return { ok: true, icon, emoji: false }
  if (isIconKey(icon)) return { ok: true, icon, emoji: false }
  if (isEmojiIcon(icon)) return { ok: true, icon, emoji: true }
  return { ok: false }
}
