import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { loadWebServerSettings, webServerDeployFields } from './web-server-settings.ts'

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

const DEFAULTS = { hideWebServerNames: true, sendViaHeader: false }

test('loadWebServerSettings hides names and drops Via when nothing is set or a row is missing', async () => {
  assertEquals(
    await loadWebServerSettings(fakeDb([{ options: {} }, { options: {} }]), 's', 'o'),
    DEFAULTS
  )
  assertEquals(await loadWebServerSettings(fakeDb([undefined, undefined]), 's', 'o'), DEFAULTS)
})

test('loadWebServerSettings follows the organization, and the server wins', async () => {
  const org = { options: { hideWebServerNames: false, sendViaHeader: true } }
  assertEquals(await loadWebServerSettings(fakeDb([{ options: {} }, org]), 's', 'o'), {
    hideWebServerNames: false,
    sendViaHeader: true,
  })
  assertEquals(
    await loadWebServerSettings(
      fakeDb([{ options: { hideWebServerNames: true, sendViaHeader: false } }, org]),
      's',
      'o'
    ),
    DEFAULTS
  )
})

test('webServerDeployFields carries both switches', () => {
  const on = { hideWebServerNames: true, sendViaHeader: true }
  assertEquals(webServerDeployFields(on), on)
  assertEquals(webServerDeployFields(DEFAULTS), DEFAULTS)
})
