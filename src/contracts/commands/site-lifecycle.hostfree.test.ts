import { assertEquals, assertThrows } from '@std/assert'
import type { CommandType } from '../../features/commands/types.ts'
import { type EnvironmentDeploySite, parseCommandPayload } from './schemas.ts'

const test = Deno.test.bind(Deno)

const PRINCIPAL = { principalId: '00000000-0000-4000-8000-000000000001', username: 'appuser' }

function parseSite(site: Record<string, unknown>): EnvironmentDeploySite | undefined {
  const parsed = parseCommandPayload('environment.deploy' as CommandType, {
    environmentId: 'env-1',
    projectId: 'proj-1',
    organizationId: 'org-1',
    projectName: 'tp-demo',
    composeFiles: [{ filename: 'compose.yaml', role: 'runtime', content: 'services: {}\n' }],
    hostings: [],
    sites: [
      {
        composeServiceName: 'blog',
        engine: 'caddy',
        root: 'public',
        listenPort: 18080,
        principal: PRINCIPAL,
        ...site,
      },
    ],
  }) as { sites: EnvironmentDeploySite[] }
  return parsed.sites[0]
}

const refuse = (site: Record<string, unknown>) => assertThrows(() => parseSite(site), Error)

test('post-deploy commands and workers parse, and absent stays absent', () => {
  const plain = parseSite({})
  assertEquals(plain?.postDeploy, undefined)
  assertEquals(plain?.workers, undefined)

  const site = parseSite({
    postDeploy: {
      commands: [['/usr/local/bin/php', 'artisan', 'migrate', '--force']],
      timeoutSeconds: 30,
      timing: 'after-switch',
    },
    workers: [
      {
        name: 'queue',
        command: ['/usr/local/bin/php', 'artisan', 'queue:work'],
        processes: 8,
        stopTimeoutSeconds: 3600,
        memoryMaxBytes: 64 * 1024 * 1024,
      },
    ],
  })
  assertEquals(site?.postDeploy?.timing, 'after-switch')
  assertEquals(site?.postDeploy?.timeoutSeconds, 30)
  assertEquals(site?.workers?.[0]?.processes, 8)
  assertEquals(site?.workers?.[0]?.memoryMaxBytes, 64 * 1024 * 1024)
})

test('post-deploy commands refuse bad lists, argv, limits and timing', () => {
  const ok = ['/bin/true']
  refuse({ postDeploy: { commands: [] } })
  refuse({ postDeploy: { commands: Array.from({ length: 11 }, () => ok) } })
  refuse({ postDeploy: { commands: [['php', 'artisan']] } })
  refuse({ postDeploy: { commands: [['/bin/true', '']] } })
  refuse({ postDeploy: { commands: [['/bin/true', 'a\nb']] } })
  refuse({ postDeploy: { commands: [['/bin/true', 'a'.repeat(513)]] } })
  refuse({ postDeploy: { commands: [ok], timeoutSeconds: 29 } })
  refuse({ postDeploy: { commands: [ok], timeoutSeconds: 1801 } })
  refuse({ postDeploy: { commands: [ok], timeoutSeconds: 60.5 } })
  refuse({ postDeploy: { commands: [ok], timing: 'later' } })
  assertEquals(
    parseSite({
      postDeploy: { commands: Array.from({ length: 10 }, () => ok), timeoutSeconds: 1800 },
    })?.postDeploy?.commands.length,
    10
  )
})

test('workers refuse bad names, duplicates, counts and limits', () => {
  const command = ['/bin/true']
  refuse({ workers: [{ name: 'Queue', command }] })
  refuse({ workers: [{ name: '-queue', command }] })
  refuse({ workers: [{ name: 'a'.repeat(33), command }] })
  refuse({ workers: [{ name: 'queue', command: ['artisan'] }] })
  refuse({
    workers: [
      { name: 'queue', command },
      { name: 'queue', command },
    ],
  })
  refuse({ workers: Array.from({ length: 11 }, (_, index) => ({ name: `w${index}`, command })) })
  refuse({ workers: [{ name: 'queue', command, processes: 0 }] })
  refuse({ workers: [{ name: 'queue', command, processes: 9 }] })
  refuse({ workers: [{ name: 'queue', command, stopTimeoutSeconds: 9 }] })
  refuse({ workers: [{ name: 'queue', command, stopTimeoutSeconds: 3601 }] })
  refuse({ workers: [{ name: 'queue', command, memoryMaxBytes: 64 * 1024 * 1024 - 1 }] })
  refuse({ workers: [{ name: 'queue', command, memoryMaxBytes: 64 * 1024 * 1024 * 1024 + 1 }] })
  assertEquals(
    parseSite({
      workers: Array.from({ length: 10 }, (_, index) => ({ name: `w${index}`, command })),
    })?.workers?.length,
    10
  )
})

test('commands and workers need a principal, and commands need a release', () => {
  const postDeploy = { commands: [['/bin/true']] }
  const workers = [{ name: 'queue', command: ['/bin/true'] }]
  refuse({ principal: undefined, postDeploy })
  refuse({ principal: undefined, workers })
  refuse({ sourceKind: 'managed-directory', postDeploy })
  assertEquals(parseSite({ sourceKind: 'managed-directory', workers })?.workers?.length, 1)
  assertEquals(parseSite({ workers: [] })?.workers, [])
})
