#!/usr/bin/env node
/**
 * Pick the turbopaneld branch the contract-twin job in build.yml checks out.
 *
 * Default (unchanged): the branch with this pull request's name in
 * TurboPanel/turbopaneld, else trunk. Promotion pull requests (head or base
 * staging/live) always use trunk.
 *
 * Override: a pull request from a fork, or one whose daemon twin has another
 * name, can name the sibling branch with one line in its description:
 *
 *   Sibling-Branch: feat/my-daemon-change
 *
 * The branch must exist in TurboPanel/turbopaneld (a maintainer pushes it
 * there for a fork). The description is untrusted text: it only ever comes
 * in through the environment, and the value must match SAFE_BRANCH or the
 * job fails without echoing it.
 *
 *   node scripts/resolve-sibling-ref.mjs           # prints candidate= and source=
 *   node scripts/resolve-sibling-ref.mjs summary   # prints the job summary
 *
 * Environment: HEAD_REF, BASE_REF, PR_BODY (resolve); SIBLING_REPO, REF,
 * SOURCE (summary). The daemon repository keeps a twin of this logic in
 * scripts/resolve-sibling-ref.ts; change both together.
 */
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const SIBLING_BRANCH_KEY = 'Sibling-Branch'

const SAFE_BRANCH = /^[A-Za-z0-9._/-]{1,100}$/
// Column 0 only, so an indented example in a code block never counts.
const KEY_LINE = /^sibling-branch[ \t]*:(.*)$/i
const PROMOTION_BRANCHES = new Set(['staging', 'live'])

/** True when `name` is a plain branch name that is safe to put in a URL and an output line. */
export function isSafeBranchName(name) {
  if (typeof name !== 'string' || !SAFE_BRANCH.test(name)) return false
  if (name.startsWith('-') || name.startsWith('.') || name.startsWith('/')) return false
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
  return !name.includes('..') && !name.includes('//') && !name.includes('/.')
}

/**
 * Read the optional `Sibling-Branch:` line from a pull request description.
 * Returns `{ branch: null }` when there is none, `{ error }` when the line is
 * repeated or its value is not a safe branch name.
 */
export function parseSiblingBranch(body) {
  const values = []
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const match = KEY_LINE.exec(line)
    if (match) values.push(match[1].trim())
  }
  if (values.length === 0) return { branch: null }
  if (values.length > 1) {
    return { error: `the description has more than one ${SIBLING_BRANCH_KEY} line` }
  }
  if (!isSafeBranchName(values[0])) {
    return {
      error:
        `the ${SIBLING_BRANCH_KEY} value is not a plain branch name ` +
        '(letters, digits, ".", "_", "-" and "/", at most 100 characters)',
    }
  }
  return { branch: values[0] }
}

/**
 * The branch to try first and why. `source` is `promotion` (always trunk),
 * `override` (named in the description) or `same-name` (this pull request's
 * own branch name, which falls back to trunk when the sibling lacks it).
 */
export function resolveSiblingRef({ headRef, baseRef, prBody }) {
  if (PROMOTION_BRANCHES.has(headRef) || PROMOTION_BRANCHES.has(baseRef)) {
    return { candidate: 'trunk', source: 'promotion' }
  }
  const parsed = parseSiblingBranch(prBody)
  if (parsed.error) return { error: parsed.error }
  if (parsed.branch) return { candidate: parsed.branch, source: 'override' }
  return { candidate: headRef || 'trunk', source: 'same-name' }
}

const HOW = {
  promotion: 'promotion pull requests always compare against trunk',
  override: `named by the ${SIBLING_BRANCH_KEY} line in the pull request description`,
  'same-name': 'the branch with the same name as this one',
  'trunk-fallback': 'trunk, because no branch with the same name exists there',
}

/** Markdown for the job summary: which sibling ref was used, and the twin merge order. */
export function summaryMarkdown({ siblingRepo, ref, source }) {
  const lines = [
    '### Contract sibling',
    '',
    `Checked against \`${siblingRepo}\` at \`${ref}\` (${HOW[source] ?? source}).`,
  ]
  if (source === 'trunk-fallback') {
    lines.push(
      '',
      `To compare against another branch of \`${siblingRepo}\`, add a line ` +
        `\`${SIBLING_BRANCH_KEY}: <branch>\` to the pull request description and re-run this job. ` +
        'For a pull request from a fork, a maintainer first pushes the matching branch to the ' +
        'TurboPanel repository.'
    )
  }
  if (ref !== 'trunk') {
    lines.push(
      '',
      'Twin pull requests: when a change touches the messages between the control plane and ' +
        'the daemon, merge the turbopanel pull request first, then the turbopaneld one.'
    )
  }
  return `${lines.join('\n')}\n`
}

function main(argv, env) {
  if (argv[0] === 'summary') {
    process.stdout.write(
      summaryMarkdown({ siblingRepo: env.SIBLING_REPO, ref: env.REF, source: env.SOURCE })
    )
    return 0
  }
  const result = resolveSiblingRef({
    headRef: env.HEAD_REF ?? '',
    baseRef: env.BASE_REF ?? '',
    prBody: env.PR_BODY ?? '',
  })
  if (result.error) {
    process.stdout.write(`::error title=${SIBLING_BRANCH_KEY}::${result.error}\n`)
    return 1
  }
  process.stdout.write(`candidate=${result.candidate}\nsource=${result.source}\n`)
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env)
}
