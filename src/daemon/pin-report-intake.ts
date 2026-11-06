/**
 * The signed pin report on the first presence hello of a signed session,
 * shared by the Deno socket (`deno-ws.ts`) and the cell (`cell/do.ts`): verify
 * it with the daemon key the upgrade checked, then record it against this
 * control plane's keys. Never throws; an unproven report changes nothing.
 */
import type { Db } from '../db/connection.ts'
import { recordPinReport } from '../features/servers/pin-report.ts'
import type { PanelIdentity } from '../lib/panel-identity/identity.ts'
import { markedPasskeysHash } from '../lib/panel-identity/keyset-store.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'
import { verifyPinReport } from './authn/pin-report.ts'

export async function intakeHelloPinReport(
  panelPin: unknown,
  ctx: {
    sessionId: string
    serverId: string
    keyId: string | undefined
    publicJwk: JsonWebKey | undefined
    /** Read only after the report verified, off the session's critical path. */
    identity: () => Promise<PanelIdentity | null>
    secrets: DerivedSecretsConfig | undefined
    /** Runs `fn` with a database client for this one write (Workers: per request). */
    withDb: (fn: (db: Db) => Promise<boolean>) => Promise<unknown>
  }
): Promise<void> {
  if (panelPin === undefined) return
  const report = await verifyPinReport(panelPin, { ...ctx, nowMs: Date.now() })
  if (!report) return
  const identity = await ctx.identity().catch(() => null)
  if (!identity) return
  const kids = { current: identity.current.kid, next: identity.next?.kid ?? null }
  await ctx.withDb(async (db) => {
    // Only a daemon that reports its rotation passkeys costs this read.
    const passkeys =
      report.passkeys === undefined ? null : await markedPasskeysHash(db).catch(() => null)
    return await recordPinReport(db, ctx.secrets, ctx.serverId, report, { ...kids, passkeys })
  })
}
