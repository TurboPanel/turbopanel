import { describe, expect, it } from 'vitest'
import {
  buildDevSyncTarArgs,
  DEV_SYNC_RUNTIME_LOCAL_EXCLUDES,
  DEV_SYNC_SOURCE_ALLOWLIST,
} from './dev-sync-archive.ts'

describe('dev-sync archive selection', () => {
  it('never ships the host-local .env to other nodes', () => {
    expect(DEV_SYNC_SOURCE_ALLOWLIST).not.toContain('.env')
    expect(DEV_SYNC_RUNTIME_LOCAL_EXCLUDES).toContain('.env')

    const args = buildDevSyncTarArgs('/repo', '/tmp/out.tgz')
    // .env must never appear as a positional source entry…
    expect(args).not.toContain('.env')
    // …and must be explicitly excluded.
    expect(args).toContain('--exclude=.env')
  })

  it('ships the checked-in orchestration/roles tree', () => {
    expect(DEV_SYNC_SOURCE_ALLOWLIST).toContain('orchestration')
    expect(DEV_SYNC_RUNTIME_LOCAL_EXCLUDES).not.toContain('orchestration/roles')

    const args = buildDevSyncTarArgs('/repo', '/tmp/out.tgz')
    expect(args).toContain('orchestration')
    expect(args.some((arg) => arg === '--exclude=orchestration/roles')).toBe(
      false,
    )
  })

  it('matches the run.sh source artifact allowlist', () => {
    expect([...DEV_SYNC_SOURCE_ALLOWLIST]).toEqual([
      'main.ts',
      'deno.json',
      'deno.lock',
      'embedded-orchestration.ts',
      'src',
      'orchestration',
      'scripts',
    ])
  })
})
