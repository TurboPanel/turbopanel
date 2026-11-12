/**
 * Real dependencies for the DNS-01 engine: settings, the Cloudflare TXT
 * writer, DNS lookups, the alert sender and the daemon push. Built once per
 * tick or request from the process-level pieces `server.ts` holds.
 */
import type { Db } from '../../../../db/connection.ts'
import { resolveInstanceAcmeSettings } from '../../../../features/install/instance-acme-settings.ts'
import { emitNotification, type EmitEmail } from '../../../../features/notifications/emit.ts'
import { createCloudflareDnsChallenge } from '../../../../features/tunnels/cloudflare-dns-challenge.ts'
import { openAccountToken } from '../accounts.ts'
import { networkFetch } from '../service.ts'
import { type DaemonApplyDeps, pushHostnamesToDaemon } from './apply.ts'
import type { Dns01Deps } from './order.ts'
import { denoDnsLookup, type DnsLookup } from './preflight.ts'

export type Dns01RuntimeDeps = DaemonApplyDeps & {
  fetch?: typeof fetch
  /** The alert mail settings, or a resolver called at send time (the console link follows the saved primary hostname). */
  email?: EmitEmail | (() => Promise<EmitEmail>)
  dns?: DnsLookup
  now?: () => Date
  random?: () => number
}

export async function buildDns01Deps(db: Db, runtime: Dns01RuntimeDeps): Promise<Dns01Deps> {
  const fetchImpl = runtime.fetch ?? networkFetch
  return {
    db,
    now: runtime.now ?? (() => new Date()),
    random: runtime.random ?? Math.random,
    fetch: fetchImpl,
    dns: runtime.dns ?? denoDnsLookup,
    dataEncryption: runtime.dataEncryption,
    settings: await resolveInstanceAcmeSettings(db, runtime.env),
    challengeProvider: async (account) =>
      createCloudflareDnsChallenge({
        token: await openAccountToken(db, runtime.dataEncryption, account),
        fetch: fetchImpl,
      }),
    notify: async (context) => {
      const email = typeof runtime.email === 'function' ? await runtime.email() : runtime.email
      await emitNotification(
        db,
        runtime.dataEncryption,
        { event: 'certificate.expiring', context, targetType: 'instance' },
        { allowPrivateTargets: true, ...(email ? { email } : {}) }
      )
    },
    applyToDaemon: () => pushHostnamesToDaemon(db, runtime),
  }
}
