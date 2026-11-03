import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { setUpdateManifestProvider } from '../features/update/manifest.ts'
import { registerInstanceUpdatesAdminRoutes } from './instance-updates-routes.ts'

const test = Deno.test.bind(Deno)

const DEV_ENV = 'TURBOPANEL_DEV_SURFACE'

async function readStatus(
  runtime: 'deno' | 'workers'
): Promise<{ development: boolean; daemonsBehind: boolean }> {
  const admin = new Hono<AppEnv>()
  registerInstanceUpdatesAdminRoutes(admin, { runtime, getEnv: () => ({}) })
  const res = await admin.request('/instance/updates')
  assertEquals(res.status, 200)
  return (await res.json()) as { development: boolean; daemonsBehind: boolean }
}

async function withDevSurface(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = Deno.env.get(DEV_ENV)
  // A fixed daemon target keeps the read off the network.
  setUpdateManifestProvider(() =>
    Promise.resolve({
      commit: 'built+1767225600',
      buildId: 'dev-built',
      builtAt: '2026-01-01T00:00:00.000Z',
      channel: 'trunk',
      manifestUrl: '/repo/dist/manifest.json',
    })
  )
  try {
    if (value === undefined) Deno.env.delete(DEV_ENV)
    else Deno.env.set(DEV_ENV, value)
    await fn()
  } finally {
    setUpdateManifestProvider(null)
    if (previous === undefined) Deno.env.delete(DEV_ENV)
    else Deno.env.set(DEV_ENV, previous)
  }
}

test('GET /instance/updates reports development only on a Deno development install', async () => {
  await withDevSurface('1', async () => {
    assertEquals((await readStatus('deno')).development, true)
    // Workers is never a development install, whatever the environment says.
    assertEquals((await readStatus('workers')).development, false)
  })
  await withDevSurface(undefined, async () => {
    assertEquals((await readStatus('deno')).development, false)
  })
  await withDevSurface('true', async () => {
    assertEquals((await readStatus('deno')).development, false)
  })
})
