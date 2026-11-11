import { assertEquals } from '@std/assert'
import { parseAllOrganizationsField } from './all-organizations.ts'

const test = Deno.test.bind(Deno)

test('an absent field leaves the switch alone', () => {
  assertEquals(parseAllOrganizationsField({}), { ok: true, value: undefined })
  assertEquals(parseAllOrganizationsField(null), { ok: true, value: undefined })
})

test('a boolean sets the switch', () => {
  assertEquals(parseAllOrganizationsField({ allOrganizations: true }), { ok: true, value: true })
  assertEquals(parseAllOrganizationsField({ allOrganizations: false }), { ok: true, value: false })
})

test('anything else is refused', () => {
  for (const bad of ['true', 1, null, {}]) {
    assertEquals(parseAllOrganizationsField({ allOrganizations: bad }), {
      ok: false,
      status: 400,
      error: 'all_organizations_invalid',
    })
  }
})
