import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { loadHideWebServerNames } from './web-server-settings.ts'

const test = Deno.test.bind(Deno)

/** Answers the two selects in order: the server row, then the organization row. */
function fakeDb(rows: Array<{ options: unknown } | undefined>): Db {
  let call = 0
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows[call++] ? [rows[call - 1]] : []),
  }
  return { select: () => chain } as unknown as Db
}

test('loadHideWebServerNames is on when nothing is set or a row is missing', async () => {
  assertEquals(
    await loadHideWebServerNames(fakeDb([{ options: {} }, { options: {} }]), 's', 'o'),
    true
  )
  assertEquals(await loadHideWebServerNames(fakeDb([undefined, undefined]), 's', 'o'), true)
})

test('loadHideWebServerNames follows the organization, and the server wins', async () => {
  const orgOff = { options: { hideWebServerNames: false } }
  assertEquals(await loadHideWebServerNames(fakeDb([{ options: {} }, orgOff]), 's', 'o'), false)
  assertEquals(
    await loadHideWebServerNames(
      fakeDb([{ options: { hideWebServerNames: true } }, orgOff]),
      's',
      'o'
    ),
    true
  )
})
