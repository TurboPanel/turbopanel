import { signWithCurrent, type PanelIdentity } from '../../lib/panel-identity/identity.ts'
import { installUrlsFor, type PublicOriginRow } from './public-origins.ts'
import {
  caFingerprintEnvValue,
  encodeInstallToken,
  isInstallTokenOrigin,
} from './daemon-install-command.ts'

export type InstallTokenResult = {
  token: string
  panelFingerprint: string
  nextFingerprint: string | null
}

/**
 * The signed `TOKEN` for an Add Server command. Every command carries one
 * except when this control plane cannot sign it: no identity key (High
 * Availability before `TURBOPANEL_IDENTITY_KEYS` is set; self-hosted always
 * has one) or an install URL that is not a bare https origin. Then it returns
 * null and the command keeps the older variables.
 */
export async function buildInstallTokenFor(opts: {
  identity: PanelIdentity | null
  licenseId: string
  licenseToken: string
  /** The origin the admin chose for this command (URL 0). */
  installUrl: string
  /** Read lazily: only a command that will carry a token needs the list. */
  hostnames: () => Promise<readonly PublicOriginRow[]>
  /** Self-hosted with a private certificate: the CA fingerprints the installer may keep. */
  caFingerprints?: readonly string[]
}): Promise<InstallTokenResult | null> {
  const { identity } = opts
  // The only fallback: without an identity key there is nothing to sign with.
  if (!identity) return null
  const installUrl = opts.installUrl.replace(/\/$/, '')
  if (!isInstallTokenOrigin(installUrl)) return null
  // URL 0 is the origin the admin chose (the installer fetches the identity
  // document there); the other origins servers dial follow, primary first.
  const others = installUrlsFor(await opts.hostnames()).filter((o) => o !== installUrl)
  const panelUrls = [installUrl, ...others].filter(isInstallTokenOrigin)
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
