import { assertEquals } from '@std/assert'
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_RULE_EVENTS,
  ruleEventOf,
  ruleTopicOf,
} from './events.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests (typescript:S2187). */
const test = Deno.test.bind(Deno)

test("a rule's event maps to its stored topic and back: `*` stores no topic", () => {
  assertEquals(ruleTopicOf('*'), null)
  assertEquals(ruleEventOf(null), '*')
  for (const event of NOTIFICATION_EVENTS) {
    assertEquals(ruleTopicOf(event), event)
  }
  for (const event of NOTIFICATION_RULE_EVENTS) {
    assertEquals(ruleEventOf(ruleTopicOf(event)), event)
  }
})
