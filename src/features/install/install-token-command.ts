import { signWithCurrent, type PanelIdentity } from '../../lib/panel-identity/identity.ts'
import { installUrlsFor } from '../../lib/panel-identity/urls.ts'
import {
  caFingerprintEnvValue,
  encodeInstallToken,
  isInstallTokenOrigin,
} from './daemon-install-command.ts'

/**
 * Environment switch for the v2 install `TOKEN`. Off until the daemon release
 * whose installer reads `TOKEN` is live on the release channel (expand only):
 * an older installer would ignore the variable and the command would fail.
 */
export const INSTALL_V2_SWITCH_ENV = 'TURBOPANEL_INSTALL_TOKEN_V2'

export function isInstallTokenV2Enabled(env: Record<string, string | undefined> | undefined) {
  const value = env?.[INSTALL_V2_SWITCH_ENV]?.trim().toLowerCase()
  return value === '1' || value === 'true'
}

export type InstallTokenResult = {
  token: string
  panelFingerprint: string
  nextFingerprint: string | null
}

/**
 * The signed `TOKEN` for an Add Server command, or null when the command
 * stays in the older form: switch off, no identity key configured, or an
 * install URL that is not a bare https origin.
 */
export async function buildInstallTokenFor(opts: {
  env: Record<string, string | undefined> | undefined
  identity: PanelIdentity | null
  licenseId: string
  licenseToken: string
  /** The origin the admin chose for this command (URL 0). */
  installUrl: string
  /** Read lazily: only a command that will carry a token needs the list. */
  hostnames: () => Promise<ReadonlyArray<{ host: string }>>
  /** Self-hosted with a private certificate: the CA fingerprints the installer may keep. */
  caFingerprints?: readonly string[]
}): Promise<InstallTokenResult | null> {
  const { identity } = opts
  if (!isInstallTokenV2Enabled(opts.env) || !identity) return null
  const installUrl = opts.installUrl.replace(/\/$/, '')
  if (!isInstallTokenOrigin(installUrl)) return null
  const panelUrls = installUrlsFor(await opts.hostnames(), installUrl).filter(isInstallTokenOrigin)
  const panelFingerprint = identity.current.kid
  const nextFingerprint = identity.next?.kid ?? null
  const token = await encodeInstallToken(
    {
      licenseId: opts.licenseId,
      licenseToken: opts.licenseToken,
      panelUrls,
      panelFingerprint,
      nextFingerprint,
      caFingerprint: caFingerprintEnvValue(opts.caFingerprints),
    },
    (bytes) => signWithCurrent(identity, bytes)
  )
  return { token, panelFingerprint, nextFingerprint }
}
