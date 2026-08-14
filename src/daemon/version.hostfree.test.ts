/**
 * Host-free coverage for co-located daemon checkout version helpers.
 */

import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import { DAEMON_API_PREFIX } from '../surfaces.ts'
import {
  getDaemonCommit,
  getDaemonRepoPath,
  getInstanceCommit,
  registerVersionRoute,
} from './version.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('getDaemonRepoPath prefers TURBOPANEL_DAEMON_REPO override', () => {
  const previous = Deno.env.get('TURBOPANEL_DAEMON_REPO')
  Deno.env.set('TURBOPANEL_DAEMON_REPO', '  /tmp/turbopanel-daemon-override  ')
  try {
    assertEquals(getDaemonRepoPath(), '/tmp/turbopanel-daemon-override')
  } finally {
    if (previous === undefined) Deno.env.delete('TURBOPANEL_DAEMON_REPO')
    else Deno.env.set('TURBOPANEL_DAEMON_REPO', previous)
  }
})

test('getDaemonRepoPath falls back to sibling turbopaneld checkout', () => {
  const previous = Deno.env.get('TURBOPANEL_DAEMON_REPO')
  Deno.env.delete('TURBOPANEL_DAEMON_REPO')
  try {
    const path = getDaemonRepoPath()
    assertEquals(path.endsWith('/turbopaneld'), true)
  } finally {
    if (previous === undefined) Deno.env.delete('TURBOPANEL_DAEMON_REPO')
    else Deno.env.set('TURBOPANEL_DAEMON_REPO', previous)
  }
})

test('getDaemonCommit returns unknown when the checkout is not a git repo', async () => {
  const previous = Deno.env.get('TURBOPANEL_DAEMON_REPO')
  const tmp = await Deno.makeTempDir({ prefix: 'tp-daemon-version-' })
  Deno.env.set('TURBOPANEL_DAEMON_REPO', tmp)
  try {
    const version = await getDaemonCommit(true)
    assertEquals(version, { commit: 'unknown', branch: 'unknown' })
  } finally {
    if (previous === undefined) Deno.env.delete('TURBOPANEL_DAEMON_REPO')
    else Deno.env.set('TURBOPANEL_DAEMON_REPO', previous)
    await Deno.remove(tmp, { recursive: true })
  }
})

test('getDaemonCommit caches briefly and force bypasses the cache', async () => {
  const previous = Deno.env.get('TURBOPANEL_DAEMON_REPO')
  Deno.env.delete('TURBOPANEL_DAEMON_REPO')
  try {
    const first = await getDaemonCommit(true)
    assertEquals(typeof first.commit, 'string')
    assertEquals(typeof first.branch, 'string')
    assertEquals(first.commit.length > 0, true)

    const cached = await getDaemonCommit(false)
    assertEquals(cached, first)

    const forced = await getDaemonCommit(true)
    assertEquals(forced.commit, first.commit)
    assertEquals(forced.branch, first.branch)
  } finally {
    if (previous === undefined) Deno.env.delete('TURBOPANEL_DAEMON_REPO')
    else Deno.env.set('TURBOPANEL_DAEMON_REPO', previous)
  }
})

test('getInstanceCommit reads the instance checkout HEAD', async () => {
  const version = await getInstanceCommit()
  assertEquals(typeof version.commit, 'string')
  assertEquals(typeof version.branch, 'string')
  assertEquals(version.commit.length > 0, true)
  assertEquals(version.branch.length > 0, true)
})

test('registerVersionRoute exposes GET /api/daemon/v1/version', async () => {
  const previous = Deno.env.get('TURBOPANEL_DAEMON_REPO')
  Deno.env.delete('TURBOPANEL_DAEMON_REPO')
  try {
    const app = new Hono()
    registerVersionRoute(app)
    const res = await app.request(`${DAEMON_API_PREFIX}/version`)
    assertEquals(res.status, 200)
    const body = await res.json()
    if (typeof body !== 'object' || body === null) {
      throw new TypeError('expected version JSON object')
    }
    const record = body as Record<string, unknown>
    assertEquals(typeof record.commit, 'string')
    assertEquals(typeof record.branch, 'string')
  } finally {
    if (previous === undefined) Deno.env.delete('TURBOPANEL_DAEMON_REPO')
    else Deno.env.set('TURBOPANEL_DAEMON_REPO', previous)
  }
})
