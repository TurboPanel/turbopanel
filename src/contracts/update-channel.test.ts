import { assertEquals, assertThrows } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'
import {
  assertValidUpdateChannelEnv,
  builtinChannelManifestUrl,
  isUpdateChannel,
  pinnedChannelManifestUrl,
  resolveInstanceUpdateChannel,
  UPDATE_CHANNELS,
  type UpdateChannel,
} from './update-channel.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const HERE = dirname(fromFileUrl(import.meta.url))
/** The sibling daemon checkout, when this is the shared five-repo tree. */
const DAEMON_URLS_TS = join(HERE, '../../../../turbopaneld/src/update/urls.ts')

test('resolveInstanceUpdateChannel defaults to release and reads TURBOPANEL_UPDATE_CHANNEL', () => {
  assertEquals(resolveInstanceUpdateChannel(undefined), 'release')
  assertEquals(resolveInstanceUpdateChannel({}), 'release')
  assertEquals(resolveInstanceUpdateChannel({ TURBOPANEL_UPDATE_CHANNEL: '  ' }), 'release')
  assertEquals(resolveInstanceUpdateChannel({ TURBOPANEL_UPDATE_CHANNEL: ' release ' }), 'release')
  assertEquals(resolveInstanceUpdateChannel({ TURBOPANEL_UPDATE_CHANNEL: 'rc' }), 'rc')
  // The request path never throws; startup does (below).
  assertEquals(resolveInstanceUpdateChannel({ TURBOPANEL_UPDATE_CHANNEL: 'stable' }), 'release')
})

test("assertValidUpdateChannelEnv throws the daemon's wording for an unknown channel", () => {
  assertValidUpdateChannelEnv(undefined)
  assertValidUpdateChannelEnv({ TURBOPANEL_UPDATE_CHANNEL: 'release' })
  assertThrows(
    () => assertValidUpdateChannelEnv({ TURBOPANEL_UPDATE_CHANNEL: 'stable' }),
    Error,
    'Invalid TURBOPANEL_UPDATE_CHANNEL: "stable". Valid values: trunk, edge, canary, rc, release'
  )
})

test("isUpdateChannel accepts exactly the daemon's vocabulary", () => {
  for (const channel of UPDATE_CHANNELS) {
    assertEquals(isUpdateChannel(channel), true)
  }
  assertEquals(isUpdateChannel('stable'), false)
  assertEquals(isUpdateChannel(''), false)
  assertEquals(isUpdateChannel(undefined), false)
})

test('builtinChannelManifestUrl: canary/rc/release on GitHub Releases, trunk and edge none', () => {
  assertEquals(builtinChannelManifestUrl('trunk'), null)
  assertEquals(
    builtinChannelManifestUrl('rc'),
    'https://github.com/TurboPanel/turbopaneld/releases/download/rc/manifest.json'
  )
  assertEquals(
    builtinChannelManifestUrl('release'),
    'https://github.com/TurboPanel/turbopaneld/releases/latest/download/manifest.json'
  )
  assertEquals(
    builtinChannelManifestUrl('canary'),
    'https://github.com/TurboPanel/turbopaneld/releases/download/canary/manifest.json'
  )
  assertEquals(builtinChannelManifestUrl('edge'), null)
})

test('pinnedChannelManifestUrl pins canary and versioned releases and leaves trunk floating', () => {
  const kinds = ['daemon', 'instance', 'ui'] as const
  const repos = {
    daemon: 'TurboPanel/turbopaneld',
    instance: 'TurboPanel/turbopanel',
    ui: 'TurboPanel/ui',
  }
  for (const kind of kinds) {
    const repo = repos[kind]
    assertEquals(
      pinnedChannelManifestUrl(kind, 'canary', '0.1.0-rc.1'),
      `https://github.com/${repo}/releases/download/canary/manifest-0.1.0-rc.1.json`
    )
    assertEquals(
      pinnedChannelManifestUrl(kind, 'rc', '0.1.1'),
      `https://github.com/${repo}/releases/download/v0.1.1/manifest.json`
    )
    assertEquals(
      pinnedChannelManifestUrl(kind, 'release', '0.1.1'),
      `https://github.com/${repo}/releases/download/v0.1.1/manifest.json`
    )
    assertEquals(pinnedChannelManifestUrl(kind, 'trunk', '0.1.1'), null)
    assertEquals(pinnedChannelManifestUrl(kind, 'edge', '0.1.1'), null)
    // 2026-09-28 naming: counter canaries and the plain -rc.
    assertEquals(
      pinnedChannelManifestUrl(kind, 'canary', '0.1.3-canary.412'),
      `https://github.com/${repo}/releases/download/canary/manifest-0.1.3-canary.412.json`
    )
    assertEquals(
      pinnedChannelManifestUrl(kind, 'rc', '0.1.3-rc'),
      `https://github.com/${repo}/releases/download/v0.1.3-rc/manifest.json`
    )
  }
  assertEquals(pinnedChannelManifestUrl('daemon', 'canary', ''), null)
  assertEquals(pinnedChannelManifestUrl('daemon', 'canary', 'v0.1.0'), null)
  assertEquals(pinnedChannelManifestUrl('daemon', 'release', '0.1.0/evil'), null)
})

test('pinnedChannelManifestUrl accepts a version only when it starts with an ASCII digit', () => {
  const pinned = (version: string) => pinnedChannelManifestUrl('daemon', 'release', version)
  for (const version of ['0', '9', '0.1.0', '7-rc.1', '1.2.3-canary.412+build_5']) {
    assertEquals(pinned(version) !== null, true, version)
  }
  for (const version of [
    '',
    'v0.1.0',
    '.1',
    '-1',
    'a1',
    '\u0661.0.0', // Arabic-Indic digit one is not an ASCII digit
    '\uFF11.0.0', // fullwidth digit one
    ' 1.0.0',
    '1.0.0\n',
    '1 0',
    '1/2',
  ]) {
    assertEquals(pinned(version), null, JSON.stringify(version))
  }
})

test("builtinChannelManifestUrl matches the daemon's table when the daemon checkout is beside this one", async () => {
  let daemon: {
    builtinChannelManifestUrl: (
      channel: UpdateChannel,
      kind?: 'daemon' | 'instance' | 'ui'
    ) => string | null
    pinnedChannelManifestUrl: (
      kind: 'daemon' | 'instance' | 'ui',
      channel: UpdateChannel,
      version: string
    ) => string | null
  }
  try {
    daemon = await import(DAEMON_URLS_TS)
  } catch {
    // CI checks this repo out alone; the daemon's own urls.test.ts pins
    // run.sh to the same table, so the three copies still meet there.
    return
  }
  const kinds = ['daemon', 'instance', 'ui'] as const
  for (const kind of kinds) {
    for (const channel of UPDATE_CHANNELS) {
      assertEquals(
        builtinChannelManifestUrl(channel, kind),
        daemon.builtinChannelManifestUrl(channel, kind),
        `${kind} ${channel}`
      )
      assertEquals(
        pinnedChannelManifestUrl(kind, channel, '0.1.2'),
        daemon.pinnedChannelManifestUrl(kind, channel, '0.1.2'),
        `pinned ${kind} ${channel}`
      )
    }
  }
})

test('wrangler pins each environment to its own channel and the dev box to trunk', async () => {
  const raw = await Deno.readTextFile(join(HERE, '../../wrangler.jsonc'))
  // Deployed environments name their channel explicitly, so the release
  // fallback never moves testing (canary) or staging (rc) off their rail.
  const channels = [...raw.matchAll(/"TURBOPANEL_UPDATE_CHANNEL":\s*"([a-z]+)"/g)].map((m) => m[1])
  assertEquals(channels, ['trunk', 'canary', 'rc', 'release'])
})
