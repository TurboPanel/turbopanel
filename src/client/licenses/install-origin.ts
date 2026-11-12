import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import type { Db } from '../../db/connection.ts'
import { isDeveloperSurfaceEnabled } from '../../app/dev-mode.ts'
import { buildLicenseInstallCommand } from '../../features/install/daemon-install-command.ts'
import { buildInstallTokenFor } from '../../features/install/install-token-command.ts'
import { controlPlaneHostnameRows } from '../../features/install/control-plane-origins.ts'
import { INSTALL_CA_PIN_UNAVAILABLE } from '../../features/install/install-ca-pin.ts'
import { resolveInstallOriginTls } from '../../features/install/install-trust.ts'
import { resolveInstallBaseUrl } from '../../features/install/resolve-public-base-url.ts'
import { resolveInstanceUpdateChannel } from '../../contracts/update-channel.ts'

/** The origin an install command points at, resolved before anything is minted. */
export type InstallOrigin = {
  instanceUrl: string
  insecureTls: boolean
  caFingerprints: readonly string[]
}

/**
 * Resolve the origin and TLS trust for an install command. Run it before
 * minting a ticket so a refusal leaves nothing behind. `parsedBaseUrl` is an
 * already validated caller-chosen origin, or null for the control plane's own.
 */
export async function resolveInstallOrigin(
  c: Context<AppEnv>,
  db: Db,
  opts: AuthRouteOpts,
  parsedBaseUrl: string | null
): Promise<{ ok: true; origin: InstallOrigin } | { ok: false; error: string }> {
  const instanceUrl = parsedBaseUrl ?? (await resolveInstallBaseUrl(c, opts))
  // Insecure TLS follows the dialed hostname and is bootstrap-only.
  // Let's Encrypt uses the system store. An uploaded leaf uses it only
  // when that certificate chains to a public root. A Let's Encrypt
  // sibling does not make a private upload public. A private upload is
  // refused unless the stored PEM contains the issuer that signed the
  // leaf; the installer then keeps that issuer, not curl -k. A Platform
  // CA name needs curl -k. Every Platform CA catch-all name on the
  // self-hosted :8443 listener, including a private IP or .lan alias,
  // needs -k when the leaf covers it, and is refused when it does not.
  const env = (c.get('platformEnv') as Record<string, string | undefined> | undefined) ?? {}
  const prepared = await resolveInstallOriginTls(db, instanceUrl, env, opts.runtime === 'deno', {
    readPlatformCaPem: opts.readPlatformCaPem,
  })
  if (!prepared.ok) return { ok: false, error: prepared.error }
  // A self-hosted command that bootstraps insecure TLS must say which CA
  // the server may keep; without it an on-path attacker picks one.
  if (opts.runtime === 'deno' && prepared.insecureTls && prepared.caFingerprints.length === 0) {
    return { ok: false, error: INSTALL_CA_PIN_UNAVAILABLE }
  }
  return {
    ok: true,
    origin: {
      instanceUrl,
      insecureTls: prepared.insecureTls,
      caFingerprints: prepared.caFingerprints,
    },
  }
}

/**
 * The full install command carrying one ticket pair (`joinId` + secret): the
 * signed single-value `TOKEN` form whenever this control plane has an
 * identity key to sign it with, else the older variables.
 */
export async function buildTicketInstallCommand(
  c: Context<AppEnv>,
  db: Db,
  opts: AuthRouteOpts,
  origin: InstallOrigin,
  ticket: { id: string; plaintext: string }
): Promise<string> {
  // Instance-host `/run.sh` is served only by the dev overlay Caddyfile.
  // Production / self-hosted Deno installs curl the CDN and pass TURBOPANEL_HOST.
  const devSurface = opts.runtime === 'deno' && isDeveloperSurfaceEnabled()
  const platformEnv = c.get('platformEnv') as Record<string, string | undefined> | undefined
  const installToken = await buildInstallTokenFor({
    identity: opts.panelIdentity ? await opts.panelIdentity() : null,
    licenseId: ticket.id,
    licenseToken: ticket.plaintext,
    installUrl: origin.instanceUrl,
    // Hosted: stored rows are ignored, the platform origin is the only one.
    hostnames: () => controlPlaneHostnameRows(db, opts.runtime),
    caFingerprints: origin.insecureTls ? origin.caFingerprints : undefined,
  })
  return buildLicenseInstallCommand({
    runtime: opts.runtime,
    instanceUrl: origin.instanceUrl,
    licenseId: ticket.id,
    licenseToken: ticket.plaintext,
    insecureTls: origin.insecureTls,
    caFingerprints: origin.caFingerprints,
    useInstanceRunScript: devSurface,
    updateChannel: resolveInstanceUpdateChannel(platformEnv),
    token: installToken?.token,
  })
}
