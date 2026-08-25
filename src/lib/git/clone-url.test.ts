import { assertEquals } from '@std/assert'
import {
  branchFromGitRef,
  commitSubject,
  COMMIT_AUTHOR_MAX_CHARS,
  COMMIT_MESSAGE_MAX_CHARS,
  isCommitSha,
  isSshCloneUrl,
  NULL_COMMIT_SHA,
  parseRepositoryOwnerRepo,
  repositoryPathFromCloneUrl,
  trimCommitField,
} from './clone-url.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isSshCloneUrl recognizes ssh:// and scp-like git@host:path forms', () => {
  assertEquals(isSshCloneUrl('ssh://git@github.com/org/repo.git'), true)
  assertEquals(isSshCloneUrl('git@github.com:org/repo.git'), true)
  assertEquals(isSshCloneUrl('git@gitlab.example.com:group/sub/repo.git'), true)
  assertEquals(isSshCloneUrl('https://github.com/org/repo.git'), false)
  assertEquals(isSshCloneUrl('git@invalid'), false)
})

test('parseRepositoryOwnerRepo extracts owner and repo from HTTPS URLs', () => {
  assertEquals(
    parseRepositoryOwnerRepo('https://github.com/TurboPanel/turbopanel.git'),
    { owner: 'TurboPanel', repo: 'turbopanel' },
  )
  assertEquals(
    parseRepositoryOwnerRepo('https://gitlab.com/group/subgroup/project'),
    { owner: 'subgroup', repo: 'project' },
  )
  assertEquals(parseRepositoryOwnerRepo('https://github.com/only-owner'), null)
  assertEquals(parseRepositoryOwnerRepo('not-a-url'), null)
})

test('parseRepositoryOwnerRepo handles scp-like SSH clone URLs', () => {
  assertEquals(
    parseRepositoryOwnerRepo('git@github.com:TurboPanel/turbopanel.git'),
    { owner: 'TurboPanel', repo: 'turbopanel' },
  )
})

test('repositoryPathFromCloneUrl returns the full namespace path', () => {
  assertEquals(
    repositoryPathFromCloneUrl('https://gitlab.com/group/subgroup/project.git'),
    'group/subgroup/project',
  )
  assertEquals(
    repositoryPathFromCloneUrl('git@gitlab.com:acme/widgets.git'),
    'acme/widgets',
  )
  assertEquals(repositoryPathFromCloneUrl('https://github.com/solo'), null)
})

test('trimCommitField trims, caps, and drops empty values', () => {
  assertEquals(trimCommitField('  hello  ', 10), 'hello')
  const capped = trimCommitField(
    'x'.repeat(COMMIT_MESSAGE_MAX_CHARS + 5),
    COMMIT_MESSAGE_MAX_CHARS,
  )
  if (capped === undefined) throw new TypeError('expected capped commit field')
  assertEquals(capped.length, COMMIT_MESSAGE_MAX_CHARS)
  assertEquals(trimCommitField('   ', COMMIT_AUTHOR_MAX_CHARS), undefined)
  assertEquals(trimCommitField(42, 10), undefined)
})

test('commitSubject keeps only the first line and caps length', () => {
  assertEquals(commitSubject('feat: ship it\n\nbody'), 'feat: ship it')
  assertEquals(commitSubject('  \nignored'), undefined)
  const longFirstLine = 'x'.repeat(COMMIT_MESSAGE_MAX_CHARS + 10)
  const subject = commitSubject(`${longFirstLine}\nbody`)
  if (subject === undefined) throw new TypeError('expected capped commit subject')
  assertEquals(subject.length, COMMIT_MESSAGE_MAX_CHARS)
})

test('branchFromGitRef accepts only refs/heads/*', () => {
  assertEquals(branchFromGitRef('refs/heads/main'), 'main')
  assertEquals(branchFromGitRef('refs/heads/feature/x'), 'feature/x')
  assertEquals(branchFromGitRef('refs/tags/v1'), null)
  assertEquals(branchFromGitRef('refs/heads/'), null)
  assertEquals(branchFromGitRef(null), null)
})

test('isCommitSha validates 40-hex SHAs and rejects the null SHA', () => {
  const valid = 'a'.repeat(40)
  assertEquals(isCommitSha(valid), true)
  assertEquals(isCommitSha(valid.toUpperCase()), true)
  assertEquals(isCommitSha(NULL_COMMIT_SHA), false)
  assertEquals(isCommitSha('abc'), false)
  assertEquals(isCommitSha(123), false)
})
