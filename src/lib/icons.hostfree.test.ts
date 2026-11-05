import { assertEquals } from '@std/assert'
import {
  EMOJI_ICON_MAX_LENGTH,
  EMOJI_ICONS_OFF_BODY,
  ICON_KEYS,
  isEmojiIcon,
  isIconKey,
  parseIconValue,
} from './icons.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('every icon key is a key and never an emoji', () => {
  for (const key of ICON_KEYS) {
    assertEquals(isIconKey(key), true, key)
    assertEquals(isEmojiIcon(key), false, key)
  }
  assertEquals(isIconKey('unicorn'), false)
  assertEquals(isIconKey(7), false)
})

test('isEmojiIcon accepts one emoji, with modifiers, joiners, flags and variation selectors', () => {
  for (const emoji of ['🚀', '👍🏽', '👩‍💻', '🇺🇸', '❤️', '👨‍👩‍👧‍👦']) {
    assertEquals(isEmojiIcon(emoji), true, emoji)
  }
})

test('isEmojiIcon refuses text, two emoji, mixed ASCII, keycaps and anything too long', () => {
  const tooLong = '\u{1F680}'.repeat(8) + 'é'
  assertEquals(tooLong.length, EMOJI_ICON_MAX_LENGTH + 1)
  for (const value of ['rocket2', 'ab', '🚀🚀', 'a🚀', '', '1️⃣', 'é', '‍', tooLong]) {
    assertEquals(isEmojiIcon(value), false, JSON.stringify(value))
  }
  assertEquals(isEmojiIcon(null), false)
  assertEquals(isEmojiIcon(42), false)
})

test('parseIconValue tells keys, emoji, null and nothing apart', () => {
  assertEquals(parseIconValue(undefined), { ok: true, icon: undefined, emoji: false })
  assertEquals(parseIconValue(null), { ok: true, icon: null, emoji: false })
  assertEquals(parseIconValue('rocket'), { ok: true, icon: 'rocket', emoji: false })
  assertEquals(parseIconValue('🚀'), { ok: true, icon: '🚀', emoji: true })
  assertEquals(parseIconValue('unicorn'), { ok: false })
  assertEquals(parseIconValue(''), { ok: false })
  assertEquals(parseIconValue(7), { ok: false })
})

test('the refusal body names the code and says what to do', () => {
  assertEquals(EMOJI_ICONS_OFF_BODY, {
    error: 'emoji_icons_off',
    message: 'This organization has emoji icons turned off. Pick one of the regular icons.',
  })
})
