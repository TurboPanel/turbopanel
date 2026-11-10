/**
 * The signed pin report on the first presence hello of a signed session,
 * shared by the Deno socket (`deno-ws.ts`) and the cell (`cell/do.ts`): verify
 * it with the daemon key the upgrade checked, then record it against this
 * control plane's keys. Never throws; an unproven report changes nothing.
 */
import type { Db } from '../db/connection.ts'
import { recordPinReport } from '../features/servers/pin-report.ts'
import type { PanelIdentity } from '../lib/panel-identity/identity.ts'
import { liveKeyset, markedPasskeysHash } from '../lib/panel-identity/keyset-store.ts'
import { compatLogWarn } from '../lib/log-compat.ts'
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
    // Only a daemon that reports its rotation passkeys costs these reads. A
    // failed read leaves both unknown: it must not read as "none marked",
    // which would flag every server that pinned the passkeys.
    let chain: { passkeys?: string | null; keyset?: number } = {}
    if (report.passkeys !== undefined) {
      try {
        const [passkeys, keyset] = await Promise.all([
          markedPasskeysHash(db),
          liveKeyset(db, identity),
        ])
        chain = { passkeys, keyset }
      } catch (err) {
        compatLogWarn(
          'pin-report',
          `rotation passkeys not read for server ${ctx.serverId}: ${err instanceof Error ? err.name : 'unknown'}`
        )
      }
    }
    return await recordPinReport(db, ctx.secrets, ctx.serverId, report, { ...kids, ...chain })
  })
}
