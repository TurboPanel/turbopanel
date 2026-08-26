/**
 * Which registered app does this delivery belong to?
 *
 * Once an instance may hold more than one GitHub App or GitLab OAuth
 * application, a delivery can no longer be verified against "the" webhook
 * secret — the surface has to work out *whose* secret to use before it can
 * authenticate anything. This module is that step, and it runs between reading
 * the raw bytes and verifying them (steps 2 and 3 of the gate in
 * `src/webhook/AGENTS.md`).
 *
 * Nothing here is trusted. Resolution only selects a candidate key; the
 * delivery is still unauthenticated until the caller verifies it.
 *
 * ## The signals, and why they are ranked this way
 *
 * **The ref in the path is authoritative.** Every app we register is handed its
 * own webhook URL ending in its `webhook_ref`, so a delivery that arrives on a
 * scoped path has already named its app unambiguously, on every provider and
 * every provider version.
 *
 * **The header is a fallback for hand-configured apps.** GitHub sends
 * `X-GitHub-Hook-Installation-Target-ID`, which for an App webhook
 * (`…-Target-Type: integration`) holds the **App id** — not the installation
 * id. Every installation of one App shares it, so it selects the app and never
 * the installation. That distinction is the bug in handlers like
 * (`GithubApp::where('app_id', $header)->first()`): with one App installed
 * across several accounts, the first-created row always wins and the other
 * installations silently stop deploying. Here the App id selects the *key* and
 * the payload's `installation.id` selects the *tenant* — see
 * `loadInstallations` in `src/client/sources/webhook-trigger.ts`.
 *
 * GitLab has no such header. It echoes the configured secret verbatim in
 * `X-Gitlab-Token`, so the token itself is the routing signal: apps store a
 * digest of it (`hashWebhookToken`) and the fallback is a single indexed lookup.
 * The digest only *finds* the row — `verifyGitlabWebhookToken` still does the
 * constant-time compare against the sealed value.
 *
 * **A ref and a header that disagree is a hard failure.** It means the URL and
 * the credentials belong to different apps, which is a misconfiguration that
 * would otherwise present as deliveries silently landing on the wrong tenant.
 */

import type { Db } from '../../db.ts'
import type { DerivedSecretsConfig } from '../../client/authn/secrets.ts'
import {
  findGitAppByWebhookRef,
  findGithubAppsByExternalAppId,
  findGitlabAppByWebhookTokenHash,
  hashWebhookToken,
  type GitApp,
} from './git-app-records.ts'

/** Header naming the resource a GitHub webhook was created on. */
export const GITHUB_HOOK_TARGET_ID_HEADER = 'x-github-hook-installation-target-id'
/** `integration` for an App webhook; `repository` / `organization` otherwise. */
export const GITHUB_HOOK_TARGET_TYPE_HEADER = 'x-github-hook-installation-target-type'

/**
 * Target types that mean "this webhook is configured on the App itself", and so
 * that the target id is an App id. GitHub has spelled this `integration`
 * historically and `app` in newer documentation; accept both.
 */
const APP_TARGET_TYPES = new Set(['integration', 'app'])

export type HeaderReader = { get(name: string): string | null }

/**
 * Candidate apps for one delivery, best first.
 *
 * A list rather than a single row because a numeric GitHub App id is unique per
 * origin, not globally: github.com and a GitHub Enterprise Server instance can
 * each hold one with the same id. The caller tries each candidate's secret and
 * keeps the one that verifies — bounded, and only reachable on the header path.
 */
export type WebhookAppResolution =
  | { ok: true; candidates: GitApp[] }
  | { ok: false; reason: WebhookAppFailure }

export type WebhookAppFailure =
  /** No signal identified an app: answer 401, never an unauthenticated accept. */
  | 'unresolved'
  /** The path ref and the delivery's own headers name different apps. */
  | 'ref_header_mismatch'

function failed(reason: WebhookAppFailure): WebhookAppResolution {
  return { ok: false, reason }
}

/** The App id a GitHub delivery names, or `null` when it names none. */
export function githubTargetAppId(headers: HeaderReader): string | null {
  const type = headers.get(GITHUB_HOOK_TARGET_TYPE_HEADER)?.trim().toLowerCase() ?? ''
  if (!APP_TARGET_TYPES.has(type)) return null
  const id = headers.get(GITHUB_HOOK_TARGET_ID_HEADER)?.trim() ?? ''
  return id.length > 0 ? id : null
}

/**
 * Resolve a GitHub delivery to one or more candidate apps.
 *
 * `webhookRef` is the `:ref` path segment, or `null` when the delivery arrived
 * on the unscoped path.
 */
export async function resolveGithubWebhookApp(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  webhookRef: string | null,
  headers: HeaderReader,
): Promise<WebhookAppResolution> {
  const targetAppId = githubTargetAppId(headers)

  if (webhookRef) {
    const app = await findGitAppByWebhookRef(db, dataEncryptionSecrets, webhookRef)
    if (!app || app.provider !== 'github') return failed('unresolved')
    // Both signals present: they must agree. Disagreement means the URL and the
    // signing credentials belong to different apps, and accepting either one
    // would route a verified delivery to the wrong tenant.
    if (targetAppId && app.externalAppId !== targetAppId) {
      return failed('ref_header_mismatch')
    }
    return { ok: true, candidates: [app] }
  }

  if (!targetAppId) return failed('unresolved')
  const candidates = await findGithubAppsByExternalAppId(db, dataEncryptionSecrets, targetAppId)
  if (candidates.length === 0) return failed('unresolved')
  return { ok: true, candidates }
}

/**
 * Resolve a GitLab delivery to one candidate app.
 *
 * Unlike GitHub there is never more than one: the ref is unique, and so is the
 * token digest.
 */
export async function resolveGitlabWebhookApp(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  webhookRef: string | null,
  presentedToken: string | null,
): Promise<WebhookAppResolution> {
  if (webhookRef) {
    const app = await findGitAppByWebhookRef(db, dataEncryptionSecrets, webhookRef)
    if (!app || app.provider !== 'gitlab') return failed('unresolved')
    return { ok: true, candidates: [app] }
  }

  const token = presentedToken?.trim() ?? ''
  if (token.length === 0) return failed('unresolved')
  const app = await findGitlabAppByWebhookTokenHash(
    db,
    dataEncryptionSecrets,
    await hashWebhookToken(token),
  )
  if (!app) return failed('unresolved')
  return { ok: true, candidates: [app] }
}

/**
 * Pick the candidate whose sealed secret actually verifies the delivery.
 *
 * `verify` is the provider's own check, so this stays agnostic about whether
 * that is an HMAC over the body or a token compare. Candidates without a
 * configured webhook secret are skipped rather than treated as a pass.
 */
export async function selectVerifiedApp(
  candidates: GitApp[],
  verify: (webhookSecret: string) => Promise<boolean>,
): Promise<GitApp | null> {
  for (const candidate of candidates) {
    if (!candidate.webhookSecret) continue
    if (await verify(candidate.webhookSecret)) return candidate
  }
  return null
}

/** True when every candidate is missing its webhook secret — a config gap, not a rejection. */
export function candidatesUnconfigured(candidates: GitApp[]): boolean {
  return candidates.every((candidate) => !candidate.webhookSecret)
}
