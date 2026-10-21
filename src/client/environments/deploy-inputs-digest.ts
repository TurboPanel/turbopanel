/**
 * A digest of everything a deploy puts on a host, beyond the compiled compose
 * document: each source's commit and build inputs, the variables, the hostnames,
 * sites, apps and storage. Folded into `desiredHash`, so a redeploy that would
 * change nothing hashes the same as the last finished one and the host can skip
 * it, while a changed variable, setting or commit hashes differently.
 *
 * Two kinds of input cannot be compared between deploys, and both make the
 * digest unique so the deploy is never skipped (the safe direction):
 *
 * - a value sealed for the daemon (`tpdaemon.…`), which is re-sealed with a
 *   fresh nonce on every send, so the same value never looks the same twice;
 * - a source whose commit was not resolved to a real sha (a plain Git remote
 *   carries the branch name), because the branch may have moved.
 *
 * The digest is a SHA-256 of the canonical form; no input is stored.
 */

import { sha256HexUtf8 } from '../../features/compose/desired-hash.ts'
import { ENVELOPE_PREFIX_DAEMON } from '../../lib/secrets/data-encryption.ts'

const RESOLVED_COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/** Keys that carry a per-send secret or credential, not part of what runs. */
const SEND_ONLY_KEYS: ReadonlySet<string> = new Set(['credential', 'privateKeyEnvelope'])

type CanonicalState = { volatile: boolean }

function canonical(value: unknown, state: CanonicalState): unknown {
  if (typeof value === 'string') {
    if (value.startsWith(ENVELOPE_PREFIX_DAEMON)) state.volatile = true
    return value
  }
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, state))
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key]
    if (entry === undefined || SEND_ONLY_KEYS.has(key)) continue
    out[key] = canonical(entry, state)
  }
  return out
}

function hasUnresolvedCommit(sourceMaterial: unknown): boolean {
  if (!Array.isArray(sourceMaterial)) return false
  return sourceMaterial.some((entry) => {
    const sha = (entry as { commitSha?: unknown } | null)?.commitSha
    return typeof sha !== 'string' || !RESOLVED_COMMIT_RE.test(sha)
  })
}

/**
 * Digest of `inputs` (a plain object of the prepared deployment's parts), or a
 * one-off value when the inputs cannot be compared between deploys.
 */
export async function deployInputsDigest(inputs: Record<string, unknown>): Promise<string> {
  const state: CanonicalState = { volatile: hasUnresolvedCommit(inputs.sourceMaterial) }
  const text = JSON.stringify(canonical(inputs, state))
  return await sha256HexUtf8(state.volatile ? `${text}\n${crypto.randomUUID()}` : text)
}
