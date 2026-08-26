import { assertEquals } from '@std/assert'
import {
  githubWebhookReachability,
  webhookPathFor,
  webhookReachability,
} from './webhook-reachability.ts'
import { GITHUB_WEBHOOK_PATH } from '../../surfaces.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('a public https origin is reachable and carries no note', () => {
  const result = githubWebhookReachability(['https://panel.example.com'])
  assertEquals(result.reachable, true)
  assertEquals(result.note, null)
  assertEquals(result.webhookUrl, `https://panel.example.com${GITHUB_WEBHOOK_PATH}`)
})

test('a non-443 public origin is still reachable', () => {
  // Unlike bootstrap TLS, a custom port says nothing about routability.
  const result = githubWebhookReachability(['https://panel.example.com:8443'])
  assertEquals(result.reachable, true)
  assertEquals(result.webhookUrl, `https://panel.example.com:8443${GITHUB_WEBHOOK_PATH}`)
})

test('LAN-only origins report unreachable but still show the endpoint', () => {
  for (const origin of [
    'https://panel.lan:8443',
    'https://192.168.1.10',
    'https://10.0.0.5',
    'https://box.internal',
    'https://localhost:8443',
  ]) {
    const result = githubWebhookReachability([origin])
    assertEquals(result.reachable, false, origin)
    assertEquals(result.webhookUrl, `${origin}${GITHUB_WEBHOOK_PATH}`)
    assertEquals(typeof result.note, 'string')
  }
})

test('the first publicly reachable origin wins over a LAN one listed first', () => {
  const result = githubWebhookReachability([
    'https://panel.lan:8443',
    'https://panel.example.com',
  ])
  assertEquals(result.reachable, true)
  assertEquals(result.webhookUrl, `https://panel.example.com${GITHUB_WEBHOOK_PATH}`)
})

test('no configured origin yields no url and an explanatory note', () => {
  const result = githubWebhookReachability([])
  assertEquals(result.webhookUrl, null)
  assertEquals(result.reachable, false)
  assertEquals(typeof result.note, 'string')

  const blank = githubWebhookReachability(['  ', ''])
  assertEquals(blank.webhookUrl, null)
  assertEquals(blank.reachable, false)
})

test('a plaintext http origin is not treated as deliverable', () => {
  const result = githubWebhookReachability(['http://panel.example.com'])
  assertEquals(result.reachable, false)
})

test('the ref rides in the path only for a self-hosted origin', () => {
  // github.com stamps the App id on every delivery, so the URL an operator
  // copies stays clean and carries nothing internal.
  assertEquals(webhookPathFor('github', 'ref-1', 'https://github.com'), '/webhook/github')
  assertEquals(webhookPathFor('gitlab', 'ref-1', 'https://gitlab.com'), '/webhook/gitlab')

  // GitHub Enterprise and self-managed GitLab ship on their own cadence, so the
  // header is not a safe single point of failure — the ref is the fallback.
  assertEquals(
    webhookPathFor('github', 'ref-1', 'https://github.acme.test'),
    '/webhook/github/ref-1',
  )
  assertEquals(
    webhookPathFor('gitlab', 'ref-1', 'https://gitlab.acme.test'),
    '/webhook/gitlab/ref-1',
  )

  // A trailing slash is not a different origin.
  assertEquals(webhookPathFor('github', 'ref-1', 'https://github.com/'), '/webhook/github')

  // No ref, or no origin, means the bare path.
  assertEquals(webhookPathFor('github', null, 'https://github.acme.test'), '/webhook/github')
  assertEquals(webhookPathFor('github', 'ref-1'), '/webhook/github')
})

test('a self-hosted ref is escaped into its path segment', () => {
  assertEquals(
    webhookPathFor('github', 'a/b', 'https://github.acme.test'),
    '/webhook/github/a%2Fb',
  )
})

test('webhookReachability threads the origin through to the path', () => {
  const hosted = webhookReachability(
    ['https://panel.example.com'],
    'github',
    'ref-1',
    'https://github.com',
  )
  assertEquals(hosted.webhookUrl, 'https://panel.example.com/webhook/github')

  const enterprise = webhookReachability(
    ['https://panel.example.com'],
    'github',
    'ref-1',
    'https://github.acme.test',
  )
  assertEquals(enterprise.webhookUrl, 'https://panel.example.com/webhook/github/ref-1')
})
