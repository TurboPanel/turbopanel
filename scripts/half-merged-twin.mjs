#!/usr/bin/env node
/**
 * Explain a contract-twin failure on trunk by a wire twin that is merged on
 * one side only.
 *
 * Wire twins (a control plane and a daemon pull request with the same branch
 * name) are merged one after the other, control plane first. Between the two
 * merges one trunk has the twin and the other does not, so the trunk build of
 * any commit in that window fails the contract twin checks although nothing
 * is wrong. The contract-twin job in build.yml runs the strict checks first;
 * only when one fails on trunk (a push, a manual run, or the Release Candidate
 * pull request, whose head is trunk) does it run this script, which looks for
 * that window and nothing else:
 *
 *   a branch name with a pull request merged into trunk on one side whose
 *   merge commit the checked tree contains, and on the other side a pull
 *   request that is still open or was merged after the checked tree.
 *
 * It prints the ref to check the lagging side out at (the open pull
 * request's `refs/pull/<n>/merge`, or the later merge commit) and the job
 * runs the same strict checks again with it. Those must pass, or the job
 * stays red: a drift that the twin does not explain is still a failure. No
 * twin found, or an API error, is a failure too (fail closed).
 *
 *   node scripts/half-merged-twin.mjs   # prints twin=, self-ref=, sibling-ref=, note=
 *
 * Environment: SELF_REPO and SIBLING_REPO (owner/name), SELF_SHA and
 * SIBLING_SHA (the checked commits), GH_TOKEN. The daemon repository keeps a
 * twin of this logic in scripts/half-merged-twin.ts; change both together.
 */
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isSafeBranchName } from './resolve-sibling-ref.mjs'

/**
 * @typedef {{ branch: string, number: number, mergeCommit: string | null }} TwinPull
 *   One pull request into trunk; `mergeCommit` is null while it is open.
 * @typedef {{ repo: string, open: TwinPull[], merged: TwinPull[] }} SideListing
 *   The open and recently merged pull requests into one repository's trunk, newest first.
 * @typedef {'self' | 'sibling'} Side
 * @typedef {{
 *   branch: string, leading: Side, lagging: Side,
 *   leadingPull: TwinPull, laggingPull: TwinPull, laggingRef: string
 * }} HalfMergedTwin
 *   A twin merged on `leading` (inside the checked tree) and not yet on `lagging`.
 * @typedef {(side: Side, commit: string) => Promise<boolean>} Contains
 * @typedef {(url: string, init: RequestInit) => Promise<Response>} FetchLike
 *   The GitHub REST calls this script makes, as one injectable function.
 */

/** Branches that pair by name in both repositories but are never wire twins. */
const NOT_TWINS = /^(trunk|staging|live)$|^(version|promote|dependabot)\//

/** True when a branch name can name a wire twin. */
export function isTwinBranch(branch) {
  return isSafeBranchName(branch) && !NOT_TWINS.test(branch)
}

/**
 * Where a side stands on one twin branch.
 * @param {SideListing} listing
 * @param {Side} side
 * @param {string} branch
 * @param {Contains} contains
 */
async function sideState(listing, side, branch, contains) {
  const merged = listing.merged.find((p) => p.branch === branch)
  if (merged?.mergeCommit) {
    if (await contains(side, merged.mergeCommit)) return { kind: 'in', pull: merged }
    return { kind: 'lagging', pull: merged, ref: merged.mergeCommit }
  }
  const open = listing.open.find((p) => p.branch === branch)
  if (open) return { kind: 'lagging', pull: open, ref: `refs/pull/${open.number}/merge` }
  return { kind: 'none' }
}

/**
 * Branch names that appear on both sides, newest merge first.
 * @param {SideListing} self
 * @param {SideListing} sibling
 */
function pairedBranches(self, sibling) {
  const names = (/** @type {SideListing} */ l) =>
    new Set([...l.merged, ...l.open].map((p) => p.branch))
  const selfNames = names(self)
  const siblingNames = names(sibling)
  const seen = new Set()
  const out = []
  for (const { branch } of [...self.merged, ...sibling.merged]) {
    if (seen.has(branch)) continue
    seen.add(branch)
    if (isTwinBranch(branch) && selfNames.has(branch) && siblingNames.has(branch)) out.push(branch)
  }
  return out
}

/**
 * The newest twin that is inside one checked tree and missing from the other,
 * or null. `contains(side, commit)` says whether that side's checked tree
 * holds the commit.
 * @param {SideListing} self
 * @param {SideListing} sibling
 * @param {Contains} contains
 * @returns {Promise<HalfMergedTwin | null>}
 */
export async function findHalfMergedTwin(self, sibling, contains) {
  for (const branch of pairedBranches(self, sibling)) {
    const mine = await sideState(self, 'self', branch, contains)
    const theirs = await sideState(sibling, 'sibling', branch, contains)
    if (mine.kind === 'in' && theirs.kind === 'lagging') {
      return {
        branch,
        leading: 'self',
        lagging: 'sibling',
        leadingPull: mine.pull,
        laggingPull: theirs.pull,
        laggingRef: theirs.ref,
      }
    }
    if (theirs.kind === 'in' && mine.kind === 'lagging') {
      return {
        branch,
        leading: 'sibling',
        lagging: 'self',
        leadingPull: theirs.pull,
        laggingPull: mine.pull,
        laggingRef: mine.ref,
      }
    }
  }
  return null
}

/**
 * The GITHUB_OUTPUT lines for a found twin.
 * @param {HalfMergedTwin} twin
 * @param {Record<Side, string>} repos
 * @param {string} checkedSha
 */
export function outputLines(twin, repos, checkedSha) {
  const lagState = twin.laggingPull.mergeCommit
    ? 'was merged after this tree was checked out'
    : 'is still open'
  const lead = `${repos[twin.leading]}#${twin.leadingPull.number}`
  const lag = `${repos[twin.lagging]}#${twin.laggingPull.number}`
  const note = [
    `contract drift at ${checkedSha.slice(0, 7)} is the half-merged wire twin`,
    `${twin.branch}: ${lead} is merged, ${lag} ${lagState}.`,
    'The contracts match with both halves in, so this check passed with a warning.',
  ].join(' ')
  return [
    `twin=${twin.branch}`,
    `self-ref=${twin.lagging === 'self' ? twin.laggingRef : ''}`,
    `sibling-ref=${twin.lagging === 'sibling' ? twin.laggingRef : ''}`,
    `note=${note}`,
  ]
}

/**
 * @param {string} token
 * @param {FetchLike} fetchFn
 */
function client(token, fetchFn) {
  return async (/** @type {string} */ path) => {
    const res = await fetchFn(`https://api.github.com/${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`GitHub API ${path}: HTTP ${res.status}`)
    }
    return await res.json()
  }
}

/**
 * @param {(path: string) => Promise<any>} api
 * @param {string} repo
 * @returns {Promise<SideListing>}
 */
async function listing(api, repo) {
  const [open, closed] = await Promise.all([
    api(`repos/${repo}/pulls?state=open&base=trunk&per_page=100`),
    api(`repos/${repo}/pulls?state=closed&base=trunk&sort=updated&direction=desc&per_page=50`),
  ])
  return {
    repo,
    open: open.map((/** @type {any} */ p) => ({
      branch: p.head.ref,
      number: p.number,
      mergeCommit: null,
    })),
    merged: closed
      .filter((/** @type {any} */ p) => p.merged_at && p.merge_commit_sha)
      .map((/** @type {any} */ p) => ({
        branch: p.head.ref,
        number: p.number,
        mergeCommit: p.merge_commit_sha,
      })),
  }
}

/**
 * Look once and print the outputs. Returns the exit code: 0 with a twin,
 * 1 without one or on any error (the drift then stays a failure).
 * @param {(name: string) => string | undefined} getEnv
 * @param {FetchLike} fetchFn
 * @param {(line: string) => void} out
 * @param {(line: string) => void} err
 */
export async function main(getEnv, fetchFn, out, err) {
  try {
    const need = (/** @type {string} */ name) => {
      const value = getEnv(name) ?? ''
      if (!value) throw new Error(`${name} is not set`)
      return value
    }
    const api = client(need('GH_TOKEN'), fetchFn)
    /** @type {Record<Side, string>} */
    const repos = { self: need('SELF_REPO'), sibling: need('SIBLING_REPO') }
    /** @type {Record<Side, string>} */
    const checked = { self: need('SELF_SHA'), sibling: need('SIBLING_SHA') }
    const [self, sibling] = await Promise.all([
      listing(api, repos.self),
      listing(api, repos.sibling),
    ])
    /** @type {Contains} */
    const contains = async (side, commit) => {
      const { status } = await api(`repos/${repos[side]}/compare/${commit}...${checked[side]}`)
      return status === 'ahead' || status === 'identical'
    }
    const twin = await findHalfMergedTwin(self, sibling, contains)
    if (!twin) {
      err(
        '::error title=Contract drift::no wire twin is merged on one side only, so this drift is real: fix the contract on trunk'
      )
      return 1
    }
    for (const line of outputLines(twin, repos, checked.self)) out(line)
    return 0
  } catch (e) {
    err(
      `::error title=Contract drift::could not look for a half-merged wire twin: ${e instanceof Error ? e.message : String(e)}`
    )
    return 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(
    (name) => process.env[name],
    fetch,
    (line) => console.log(line),
    (line) => console.error(line)
  )
}
