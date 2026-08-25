import { assertEquals } from '@std/assert'
import {
  gitlabApiBase,
  gitlabApiHeaders,
  gitlabProjectId,
  toGitlabRepositorySummary,
} from './gitlab-api.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('gitlabApiBase strips trailing slashes once', () => {
  assertEquals(gitlabApiBase('https://gitlab.example.com'), 'https://gitlab.example.com/api/v4')
  assertEquals(
    gitlabApiBase('https://gitlab.example.com/'),
    'https://gitlab.example.com/api/v4',
  )
  assertEquals(
    gitlabApiBase('https://gitlab.example.com///'),
    'https://gitlab.example.com/api/v4',
  )
})

test('gitlabApiHeaders carries a bearer token', () => {
  const headers = gitlabApiHeaders('tok') as Record<string, string>
  assertEquals(headers.authorization, 'Bearer tok')
  assertEquals(headers.accept, 'application/json')
})

test('toGitlabRepositorySummary maps visibility to the private flag', () => {
  assertEquals(
    toGitlabRepositorySummary({
      id: 15,
      path_with_namespace: 'group/app',
      default_branch: 'main',
      visibility: 'private',
      http_url_to_repo: 'https://gitlab.com/group/app.git',
    }),
    {
      id: '15',
      fullName: 'group/app',
      defaultBranch: 'main',
      private: true,
      cloneUrl: 'https://gitlab.com/group/app.git',
    },
  )
  assertEquals(
    toGitlabRepositorySummary({
      id: 16,
      path_with_namespace: 'group/public',
      visibility: 'public',
    })?.private,
    false,
  )
  assertEquals(toGitlabRepositorySummary(null), null)
  assertEquals(toGitlabRepositorySummary({ path_with_namespace: '' }), null)
})

test('gitlabProjectId prefers the recorded id and falls back to the clone path', () => {
  assertEquals(gitlabProjectId('42', 'https://gitlab.com/group/app.git'), '42')
  assertEquals(
    gitlabProjectId(null, 'https://gitlab.com/group/sub/app.git'),
    'group/sub/app',
  )
  assertEquals(gitlabProjectId('  ', 'https://gitlab.com/group/app.git'), 'group/app')
  assertEquals(gitlabProjectId(null, 'not-a-url'), null)
})
