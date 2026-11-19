/**
 * A pinned certificate must be of the kind the choice names. Skips without
 * TURBOPANEL_DATABASE_URL.
 */
import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { tls } from '../../db/schema.ts'
import { withScenario } from '../../features/tunnels/nudge-scenario.test.support.ts'
import { parseNameChoices } from './name-certificates-routes.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

function ctx(): Context<AppEnv> {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

test('a pin must match the certificate the choice names', async () => {
  await withScenario({}, async (s) => {
    const pins: Record<string, string> = {}
    for (const source of ['provider_origin', 'lets_encrypt', 'upload']) {
      const [row] = await s.db
        .insert(tls)
        .values({ organizationId: s.organizationId, source, status: 'ready', name: source })
        .returning({ id: tls.id })
      pins[source] = row.id
    }
    const verdict = async (certificate: string, source: string) => {
      const result = await parseNameChoices(ctx(), s.db, s.organizationId, {
        names: [{ hostname: 'a.example.net', certificate, tlsId: pins[source] }],
      })
      if (result.kind === 'value') return 200
      if (result.kind === 'error') return result.response.status
      return 0
    }
    assertEquals(await verdict('cloudflare_origin', 'provider_origin'), 200)
    assertEquals(await verdict('letsencrypt_http', 'lets_encrypt'), 200)
    assertEquals(await verdict('letsencrypt_dns', 'lets_encrypt'), 200)
    assertEquals(await verdict('library', 'upload'), 200)
    assertEquals(await verdict('cloudflare_origin', 'lets_encrypt'), 400)
    assertEquals(await verdict('letsencrypt_http', 'provider_origin'), 400)
    assertEquals(await verdict('letsencrypt_dns', 'upload'), 400)
    assertEquals(await verdict('library', 'provider_origin'), 400)
  })
})
