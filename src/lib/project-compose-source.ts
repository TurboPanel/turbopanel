/**
 * Has the repository moved since this project's compose was seeded?
 *
 * Compares the repository bytes at the recorded path against
 * `composeSource.seededDigest`, which hashes **what was seeded**, not the
 * current project compose. That distinction is the whole design: an operator
 * editing their compose is expected and must never look like drift; the
 * repository changing underneath them is worth surfacing.
 *
 * Non-blocking by construction — this reports, it never rewrites. Re-seeding is
 * an explicit operator act with a diff in front of it.
 */

import { composeSourceDigest, type ProjectComposeSource } from './project-options.ts'

export type ComposeSourceDrift =
  | { state: 'unchanged' }
  | { state: 'drifted'; seededCommitSha: string; currentCommitSha: string }
  | { state: 'unreadable'; reason: string }
  | { state: 'not_seeded' }

export async function detectComposeSourceDrift(params: {
  composeSource: ProjectComposeSource | undefined
  read: () => Promise<
    { ok: true; commitSha: string; content: string | null } | { ok: false; reason: string }
  >
}): Promise<ComposeSourceDrift> {
  if (!params.composeSource) return { state: 'not_seeded' }

  const result = await params.read()
  if (!result.ok) return { state: 'unreadable', reason: result.reason }
  if (result.content === null) {
    // The file the project was seeded from is gone. That IS drift — the
    // operator should know their provenance no longer resolves.
    return {
      state: 'drifted',
      seededCommitSha: params.composeSource.seededCommitSha,
      currentCommitSha: result.commitSha,
    }
  }

  const digest = await composeSourceDigest(result.content)
  if (digest === params.composeSource.seededDigest) return { state: 'unchanged' }
  return {
    state: 'drifted',
    seededCommitSha: params.composeSource.seededCommitSha,
    currentCommitSha: result.commitSha,
  }
}
