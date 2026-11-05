/**
 * The signed pin report on the first presence hello of a signed session,
 * shared by the Deno socket (`deno-ws.ts`) and the cell (`cell/do.ts`): verify
 * it with the daemon key the upgrade checked, then record it against this
 * control plane's keys. Never throws; an unproven report changes nothing.
 */
import type { Db } from '../db/connection.ts'
import { recordPinReport } from '../features/servers/pin-report.ts'
import type { PanelIdentity } from '../lib/panel-identity/identity.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'
import { verifyPinReport } from './authn/pin-report.ts'

export async function intakeHelloPinReport(
  panelPin: unknown,
  ctx: {
    sessionId: string
    serverId: string
    keyId: string | undefined
    publicJwk: JsonWebKey | undefined
    identity: PanelIdentity | null
    secrets: DerivedSecretsConfig | undefined
    /** Runs `fn` with a database client for this one write (Workers: per request). */
    withDb: (fn: (db: Db) => Promise<boolean>) => Promise<unknown>
  }
): Promise<void> {
  if (panelPin === undefined || !ctx.identity) return
  const report = await verifyPinReport(panelPin, { ...ctx, nowMs: Date.now() })
  if (!report) return
  const kids = { current: ctx.identity.current.kid, next: ctx.identity.next?.kid ?? null }
  await ctx.withDb((db) => recordPinReport(db, ctx.secrets, ctx.serverId, report, kids))
}
