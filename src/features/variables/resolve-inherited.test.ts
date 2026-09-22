import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  mergeHostingVariablesForService,
  resolveInheritedVariablesForEnvironment,
  type ResolvedVariableMap,
} from './resolve-inherited.ts'

type VariableRow = {
  key: string
  value: string
  isSecret: boolean
  isLiteral: boolean
  forBuild: boolean
  forRuntime: boolean
}

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

function createEnvironmentInheritanceDb(opts: {
  chain: {
    organizationId: string
    workspaceId: string
    projectId: string
  } | null
  variablesByScope: Partial<Record<
    'organizationId' | 'workspaceId' | 'projectId' | 'environmentId',
    VariableRow[]
  >>
  environmentId: string
}): Parameters<typeof resolveInheritedVariablesForEnvironment>[0] {
  let selectCalls = 0
  const scopeOrder = [
    'organizationId',
    'workspaceId',
    'projectId',
    'environmentId',
  ] as const

  return {
    select() {
      selectCalls += 1
      if (selectCalls === 1) {
        return {
          from: () => ({
            innerJoin: () => ({
              innerJoin: () => ({
                where: () => ({
                  limit: () => Promise.resolve(opts.chain ? [opts.chain] : []),
                }),
              }),
            }),
          }),
        }
      }

      const scopeIndex = selectCalls - 2
      const scope = scopeOrder[scopeIndex]
      const rows = scope
        ? (opts.variablesByScope[scope] ?? [])
        : []

      return {
        from: () => ({
          where: () => thenableRows(rows),
        }),
      }
    },
  } as unknown as Parameters<typeof resolveInheritedVariablesForEnvironment>[0]
}

/**
 * Stub Db for {@link mergeHostingVariablesForService}: first select returns
 * hosting ids; subsequent selects return variable rows in sorted hosting-id
 * order (matching the production sort before loadVariablesForParent).
 */
function createMergeHostingDb(opts: {
  hostingIds: string[]
  variablesByHostingId: Record<string, VariableRow[]>
}): Parameters<typeof mergeHostingVariablesForService>[0] {
  let hostingQueryDone = false
  const variableQueue = [...opts.hostingIds]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => opts.variablesByHostingId[id] ?? [])

  return {
    select() {
      if (!hostingQueryDone) {
        hostingQueryDone = true
        return {
          from() {
            return {
              where() {
                return Promise.resolve(opts.hostingIds.map((id) => ({ id })))
              },
            }
          },
        }
      }

      return {
        from() {
          return {
            where() {
              return Promise.resolve(variableQueue.shift() ?? [])
            },
          }
        },
      }
    },
  } as unknown as Parameters<typeof mergeHostingVariablesForService>[0]
}

describe('mergeHostingVariablesForService', () => {
  it('merges hosting vars with later hosting ids winning on key conflicts', async () => {
    const target: ResolvedVariableMap = new Map([
      [
        'SERVICE_ONLY',
        {
          value: 'from-service',
          isSecret: false,
          isLiteral: false,
          forBuild: false,
          forRuntime: true,
        },
      ],
    ])

    const db = createMergeHostingDb({
      hostingIds: [
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      ],
      variablesByHostingId: {
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa': [
          {
            key: 'APP_URL',
            value: 'https://a.example.com',
            isSecret: false,
            isLiteral: true,
            forBuild: false,
            forRuntime: true,
          },
          {
            key: 'SHARED',
            value: 'from-a',
            isSecret: false,
            isLiteral: false,
            forBuild: false,
            forRuntime: true,
          },
        ],
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb': [
          {
            key: 'SHARED',
            value: 'from-b',
            isSecret: false,
            isLiteral: false,
            forBuild: false,
            forRuntime: true,
          },
        ],
      },
    })

    await mergeHostingVariablesForService(
      db,
      '11111111-1111-1111-1111-111111111111',
      target,
    )

    assertEquals(target.get('SERVICE_ONLY')?.value, 'from-service')
    assertEquals(target.get('APP_URL')?.value, 'https://a.example.com')
    // Sorted a… then b… → b wins on SHARED
    assertEquals(target.get('SHARED')?.value, 'from-b')
  })

  it('is a no-op when the service has no hostings', async () => {
    const target: ResolvedVariableMap = new Map([
      [
        'KEEP',
        {
          value: 'yes',
          isSecret: false,
          isLiteral: false,
          forBuild: false,
          forRuntime: true,
        },
      ],
    ])

    await mergeHostingVariablesForService(
      createMergeHostingDb({ hostingIds: [], variablesByHostingId: {} }),
      '11111111-1111-1111-1111-111111111111',
      target,
    )

    assertEquals(target.size, 1)
    assertEquals(target.get('KEEP')?.value, 'yes')
  })
})

describe('resolveInheritedVariablesForEnvironment', () => {
  it('returns empty map when environment chain is missing', async () => {
    const resolved = await resolveInheritedVariablesForEnvironment(
      createEnvironmentInheritanceDb({
        chain: null,
        variablesByScope: {},
        environmentId: 'env-missing',
      }),
      'env-missing',
    )
    assertEquals(resolved.size, 0)
  })

  it('merges org → workspace → project → environment with later scopes winning', async () => {
    const envId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const resolved = await resolveInheritedVariablesForEnvironment(
      createEnvironmentInheritanceDb({
        chain: {
          organizationId: 'org-1',
          workspaceId: 'ws-1',
          projectId: 'proj-1',
        },
        environmentId: envId,
        variablesByScope: {
          organizationId: [{
            key: 'SHARED',
            value: 'org',
            isSecret: false,
            isLiteral: false,
            forBuild: false,
            forRuntime: true,
          }],
          workspaceId: [{
            key: 'SHARED',
            value: 'workspace',
            isSecret: false,
            isLiteral: false,
            forBuild: false,
            forRuntime: true,
          }],
          projectId: [{
            key: 'PROJECT_ONLY',
            value: 'project',
            isSecret: false,
            isLiteral: false,
            forBuild: false,
            forRuntime: true,
          }],
          environmentId: [{
            key: 'SHARED',
            value: 'environment',
            isSecret: false,
            isLiteral: true,
            forBuild: true,
            forRuntime: true,
          }],
        },
      }),
      envId,
    )

    assertEquals(resolved.get('SHARED')?.value, 'environment')
    assertEquals(resolved.get('SHARED')?.isLiteral, true)
    assertEquals(resolved.get('PROJECT_ONLY')?.value, 'project')
  })
})
