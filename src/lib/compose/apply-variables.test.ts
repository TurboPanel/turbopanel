import { describe, it } from '@std/testing/bdd'
import { assertEquals } from '@std/assert'
import {
  applyVariablesToComposeDocument,
  isApplyVariablesError,
  type ApplyVariablesResult,
  injectSecretPlaceholdersIntoComposeDocument,
  trimVariableValue,
  escapeLiteralComposeValue,
} from './apply-variables.ts'
import { emptyComposeDocument } from './types.ts'
import { composeInterpolationRef, serviceEnvInterpolationKey } from './env-file.ts'
import { secretContainerPath, secretFileEnvKey } from './secret-files.ts'

function mustApply(
  result: ReturnType<typeof applyVariablesToComposeDocument>,
): ApplyVariablesResult {
  if (isApplyVariablesError(result)) {
    throw new TypeError(result.message)
  }
  return result
}

describe('apply-variables', () => {
  it('trims variable values on edges only', () => {
    assertEquals(trimVariableValue('  hello\nworld  '), 'hello\nworld')
  })

  it('escapes dollar signs for literal compose values', () => {
    assertEquals(escapeLiteralComposeValue('$FOO'), '$$FOO')
  })

  it('injects runtime non-secrets via .env interpolation', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      web: { image: 'nginx:latest' },
    }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'PORT',
        value: '3000',
        isSecret: false,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
    }))

    const services = result.document.data.services as Record<string, Record<string, unknown>>
    const envKey = serviceEnvInterpolationKey('web', 'PORT')
    assertEquals(services.web.environment, { PORT: composeInterpolationRef(envKey) })
    assertEquals(result.envFileContent.includes('web__PORT=3000'), true)
    assertEquals(result.secretMaterial.length, 0)
  })

  it('does not auto-inject unreferenced secrets', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { api: { image: 'node:22' } }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'SECRET',
        value: 'tpsecret.v1.test',
        isSecret: true,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
    }))

    const services = result.document.data.services as Record<string, Record<string, unknown>>
    assertEquals(services.api.environment, undefined)
    assertEquals(result.secretMaterial.length, 0)
    assertEquals(result.secretPlan.length, 0)
  })

  it('rewrites {$secret} to Compose secrets and KEY_FILE', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      api: {
        image: 'node:22',
        environment: { SECRET: '{$SECRET}' },
      },
    }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'SECRET',
        value: 'super-secret',
        isSecret: true,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
      projectId: 'proj',
      environmentId: 'env',
    }))

    const services = result.document.data.services as Record<string, Record<string, unknown>>
    const env = services.api.environment as Record<string, string>
    assertEquals(env.SECRET, undefined)
    assertEquals(env[secretFileEnvKey('SECRET')], secretContainerPath('SECRET'))
    assertEquals(result.secretMaterial.length, 1)
    assertEquals(result.secretPlan[0]?.source, 'api_secret')
    assertEquals(JSON.stringify(result.document.data).includes('super-secret'), false)
    assertEquals(result.envFileContent.includes('super-secret'), false)
  })

  it('auto-attaches binding secrets without a compose ref', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { api: { image: 'node:22' } }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'DATABASE_PASSWORD',
        value: 'bound-secret',
        isSecret: true,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
        bindingId: '11111111-1111-4111-8111-111111111111',
      }],
      perServiceEntries: new Map(),
    }))

    assertEquals(result.secretMaterial.length, 1)
    assertEquals(result.secretPlan.length, 1)
    const env = (result.document.data.services as Record<string, Record<string, unknown>>)
      .api.environment as Record<string, string>
    assertEquals(env.DATABASE_PASSWORD, undefined)
    assertEquals(
      env.DATABASE_PASSWORD_FILE,
      secretContainerPath('DATABASE_PASSWORD'),
    )
  })

  it('fails closed on unresolved scoped refs', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      web: { image: 'nginx', environment: { X: '{$project.missing}' } },
    }
    const result = applyVariablesToComposeDocument(doc, {
      globalEntries: [],
      perServiceEntries: new Map(),
    })
    if (!isApplyVariablesError(result)) {
      throw new TypeError('expected unresolved error')
    }
    assertEquals(result.kind, 'variable_unresolved')
  })

  it('rejects embedded {$refs}', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      web: { image: 'nginx', environment: { X: 'prefix-{$PORT}' } },
    }
    const result = applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'PORT',
        value: '1',
        isSecret: false,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
    })
    if (!isApplyVariablesError(result)) {
      throw new TypeError('expected invalid ref error')
    }
    assertEquals(result.kind, 'variable_ref_invalid')
  })

  it('rejects Compose ${SECRET} interpolation for secret keys', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      web: { image: 'nginx', environment: { X: '${SECRET}' } },
    }
    const result = applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'SECRET',
        value: 'x',
        isSecret: true,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
    })
    if (!isApplyVariablesError(result)) {
      throw new TypeError('expected secret interpolation error')
    }
    assertEquals(result.kind, 'variable_secret_interpolation')
  })

  it('injectSecretPlaceholdersIntoComposeDocument is a no-op', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { api: { image: 'node:22' } }
    assertEquals(injectSecretPlaceholdersIntoComposeDocument(doc, []), doc)
  })

  it('merges per-service entries over globals and preserves existing env', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      api: { image: 'node:22', environment: { EXISTING: 'keep' } },
      worker: { image: 'busybox' },
    }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'GLOBAL',
        value: 'all',
        isSecret: false,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map([
        ['api', [{
          key: 'API_ONLY',
          value: 'api',
          isSecret: false,
          isLiteral: false,
          forBuild: false,
          forRuntime: true,
        }]],
      ]),
    }))

    const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
    assertEquals(api.environment, {
      EXISTING: 'keep',
      GLOBAL: composeInterpolationRef(serviceEnvInterpolationKey('api', 'GLOBAL')),
      API_ONLY: composeInterpolationRef(serviceEnvInterpolationKey('api', 'API_ONLY')),
    })
    const worker = (result.document.data.services as Record<string, Record<string, unknown>>).worker!
    assertEquals(worker.environment, {
      GLOBAL: composeInterpolationRef(serviceEnvInterpolationKey('worker', 'GLOBAL')),
    })
  })

  it('normalizes list-form environment when injecting runtime variables', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      web: {
        image: 'nginx',
        environment: ['FOO=1', 'BAR:two', 'BAZ', 'KEEP=yes'],
      },
    }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'TURBOPANEL_ENV',
        value: 'x',
        isSecret: false,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
    }))

    const web = (result.document.data.services as Record<string, Record<string, unknown>>).web!
    assertEquals(web.environment, {
      FOO: '1',
      BAR: 'two',
      BAZ: '',
      KEEP: 'yes',
      TURBOPANEL_ENV: 'x',
    })
  })

  it('applies build-only literal variables into .env interpolation', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { api: { image: 'node:22', environment: { KEEP: 'yes' } } }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'BUILD_ARG',
        value: '$SECRET',
        isSecret: false,
        isLiteral: true,
        forBuild: true,
        forRuntime: false,
      }],
      perServiceEntries: new Map(),
    }))

    const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
    assertEquals(api.environment, { KEEP: 'yes' })
    const envKey = serviceEnvInterpolationKey('api', 'BUILD_ARG')
    assertEquals(
      (api.build as { args: Record<string, string> }).args.BUILD_ARG,
      composeInterpolationRef(envKey),
    )
    assertEquals(result.envFileContent.includes(`${envKey}=`), true)
    assertEquals(result.envFileContent.includes('$$SECRET'), true)
  })

  it('preserves existing environment when no runtime entries are provided', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { api: { image: 'node:22', environment: { OLD: 'gone' } } }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [],
      perServiceEntries: new Map(),
    }))

    const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
    assertEquals(api.environment, { OLD: 'gone' })
  })

  it('resolves scoped {$project.KEY} refs', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      web: { image: 'nginx', environment: { NAME: '{$project.APP}' } },
    }
    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [],
      perServiceEntries: new Map(),
      perServiceScopes: new Map([
        ['web', {
          project: new Map([
            ['APP', {
              key: 'APP',
              value: 'demo',
              isSecret: false,
              isLiteral: false,
              forBuild: false,
              forRuntime: true,
            }],
          ]),
        }],
      ]),
    }))
    const env = (result.document.data.services as Record<string, Record<string, unknown>>)
      .web.environment as Record<string, string>
    assertEquals(
      env.NAME,
      composeInterpolationRef(serviceEnvInterpolationKey('web', 'APP')),
    )
  })

  it('rewrites build-arg secrets onto build.secrets', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      api: {
        image: 'node:22',
        build: { context: '.', args: { TOKEN: '{$TOKEN}' } },
      },
    }
    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'TOKEN',
        value: 'build-secret',
        isSecret: true,
        isLiteral: false,
        forBuild: true,
        forRuntime: false,
      }],
      perServiceEntries: new Map(),
    }))
    const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
    assertEquals((api.build as { args?: Record<string, string> }).args?.TOKEN, undefined)
    const buildSecrets = (api.build as { secrets: Array<{ source: string }> }).secrets
    assertEquals(buildSecrets[0]?.source, 'api_token')
    assertEquals(result.secretPlan[0]?.forBuild, true)
    assertEquals(result.secretPlan[0]?.forRuntime, false)
    assertEquals(JSON.stringify(result.document.data).includes('build-secret'), false)
  })

  it('merges runtime and build refs for the same secret', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      api: {
        image: 'node:22',
        environment: { TOKEN: '{$TOKEN}' },
        build: { context: '.', args: { TOKEN: '{$TOKEN}' } },
      },
    }
    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'TOKEN',
        value: 'shared-secret',
        isSecret: true,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
    }))
    assertEquals(result.secretPlan.length, 1)
    assertEquals(result.secretPlan[0]?.forRuntime, true)
    assertEquals(result.secretPlan[0]?.forBuild, true)
    const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
    const env = api.environment as Record<string, string>
    assertEquals(env.TOKEN, undefined)
    assertEquals(env.TOKEN_FILE, secretContainerPath('TOKEN'))
  })

  it('skips non-mapping service entries', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { bad: 'not-a-map', api: { image: 'node:22' } }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'PORT',
        value: '3000',
        isSecret: false,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
    }))

    const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
    assertEquals(api.environment, {
      PORT: composeInterpolationRef(serviceEnvInterpolationKey('api', 'PORT')),
    })
  })

  it('does not duplicate secret plan when binding and compose ref overlap', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      api: {
        image: 'node:22',
        environment: { DATABASE_PASSWORD: '{$DATABASE_PASSWORD}' },
      },
    }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'DATABASE_PASSWORD',
        value: 'bound-secret',
        isSecret: true,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
        bindingId: '11111111-1111-4111-8111-111111111111',
      }],
      perServiceEntries: new Map(),
    }))

    assertEquals(result.secretPlan.length, 1)
    assertEquals(result.secretMaterial.length, 1)
    const env = (result.document.data.services as Record<string, Record<string, unknown>>)
      .api.environment as Record<string, string>
    assertEquals(env.DATABASE_PASSWORD, undefined)
    assertEquals(
      env.DATABASE_PASSWORD_FILE,
      secretContainerPath('DATABASE_PASSWORD'),
    )
  })

  it('does not auto-inject build-only secrets without a compose ref', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { api: { image: 'node:22', build: { context: '.' } } }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'BUILD_TOKEN',
        value: 'build-only-secret',
        isSecret: true,
        isLiteral: false,
        forBuild: true,
        forRuntime: false,
      }],
      perServiceEntries: new Map(),
    }))

    const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
    assertEquals(api.environment, undefined)
    assertEquals((api.build as { secrets?: unknown[] }).secrets, undefined)
    assertEquals(result.secretMaterial.length, 0)
    assertEquals(result.secretPlan.length, 0)
  })

  it('auto-attaches binding secrets flagged build-only onto build.secrets only', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { api: { image: 'node:22', build: { context: '.' } } }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'BUILD_TOKEN',
        value: 'bound-build-secret',
        isSecret: true,
        isLiteral: false,
        forBuild: true,
        forRuntime: false,
        bindingId: '22222222-2222-4222-8222-222222222222',
      }],
      perServiceEntries: new Map(),
    }))

    assertEquals(result.secretPlan.length, 1)
    assertEquals(result.secretPlan[0]?.forBuild, true)
    assertEquals(result.secretPlan[0]?.forRuntime, false)
    const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
    assertEquals(api.environment, undefined)
    const buildSecrets = (api.build as { secrets: Array<{ source: string }> }).secrets
    assertEquals(buildSecrets.length, 1)
    assertEquals((api.secrets as unknown[] | undefined), undefined)
  })

  it('merges runtime and build refs for build-only secret when both targets reference it', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      api: {
        image: 'node:22',
        build: { context: '.', args: { TOKEN: '{$TOKEN}' } },
      },
    }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'TOKEN',
        value: 'build-only-secret',
        isSecret: true,
        isLiteral: false,
        forBuild: true,
        forRuntime: false,
      }],
      perServiceEntries: new Map(),
    }))

    assertEquals(result.secretPlan.length, 1)
    assertEquals(result.secretPlan[0]?.forBuild, true)
    assertEquals(result.secretPlan[0]?.forRuntime, false)
    const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
    assertEquals((api.build as { args?: Record<string, string> }).args?.TOKEN, undefined)
    assertEquals((api.secrets as unknown[] | undefined), undefined)
  })

  for (
    const [scopeLabel, scopeToken, refToken] of [
      ['organization', 'organization', 'org'],
      ['workspace', 'workspace', 'workspace'],
      ['hosting', 'hosting', 'hosting'],
      ['server', 'server', 'server'],
    ] as const
  ) {
    it(`resolves scoped {$${refToken}.KEY} via perServiceScopes (${scopeLabel})`, () => {
      const doc = emptyComposeDocument()
      doc.data.services = {
        web: { image: 'nginx', environment: { X: `{$${refToken}.SCOPE_VAR}` } },
      }
      const result = mustApply(applyVariablesToComposeDocument(doc, {
        globalEntries: [],
        perServiceEntries: new Map(),
        perServiceScopes: new Map([
          ['web', {
            [scopeToken]: new Map([
              ['SCOPE_VAR', {
                key: 'SCOPE_VAR',
                value: `${scopeLabel}-value`,
                isSecret: false,
                isLiteral: false,
                forBuild: false,
                forRuntime: true,
              }],
            ]),
          }],
        ]),
      }))
      const env = (result.document.data.services as Record<string, Record<string, unknown>>)
        .web.environment as Record<string, string>
      assertEquals(
        env.X,
        composeInterpolationRef(serviceEnvInterpolationKey('web', 'SCOPE_VAR')),
      )
      assertEquals(result.envFileContent.includes('web__SCOPE_VAR='), true)
    })
  }

  it('inlines TURBOPANEL_* build args without env file interpolation', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { api: { image: 'node:22', build: { context: '.' } } }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'TURBOPANEL_SERVICE_ID',
        value: '01989d42-9adb-7e65-bc2e-f38792c53691',
        isSecret: false,
        isLiteral: false,
        forBuild: true,
        forRuntime: false,
      }],
      perServiceEntries: new Map(),
    }))

    const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
    assertEquals(
      (api.build as { args: Record<string, string> }).args.TURBOPANEL_SERVICE_ID,
      '01989d42-9adb-7e65-bc2e-f38792c53691',
    )
    assertEquals(result.envFileContent.includes('TURBOPANEL_SERVICE_ID'), false)
  })

  it('escapes literal TURBOPANEL_* inline values in environment', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { web: { image: 'nginx' } }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'TURBOPANEL_PROJECT_ID',
        value: '$RAW',
        isSecret: false,
        isLiteral: true,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
    }))

    const env = (result.document.data.services as Record<string, Record<string, unknown>>)
      .web.environment as Record<string, string>
    assertEquals(env.TURBOPANEL_PROJECT_ID, '$$RAW')
    assertEquals(result.envFileContent.includes('TURBOPANEL_PROJECT_ID'), false)
  })

  it('normalizes list-form build.args when resolving secret refs', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      api: {
        image: 'node:22',
        build: { context: '.', args: ['KEEP=yes', 'TOKEN={$TOKEN}'] },
      },
    }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'TOKEN',
        value: 'list-build-secret',
        isSecret: true,
        isLiteral: false,
        forBuild: true,
        forRuntime: false,
      }],
      perServiceEntries: new Map(),
    }))

    const build = (result.document.data.services as Record<string, Record<string, unknown>>)
      .api.build as { args: Record<string, string>; secrets: Array<{ source: string }> }
    assertEquals(build.args, { KEEP: 'yes' })
    assertEquals(build.args.TOKEN, undefined)
    assertEquals(build.secrets.length, 1)
    assertEquals(result.secretPlan[0]?.forBuild, true)
    assertEquals(result.secretPlan[0]?.forRuntime, false)
  })

  it('promotes runtime-only secret to build when referenced in environment and build.args', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      api: {
        image: 'node:22',
        environment: { DB_PASS: '{$DB_PASS}' },
        build: { context: '.', args: ['DB_PASS={$DB_PASS}', 'STAGE=prod'] },
      },
    }

    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'DB_PASS',
        value: 'runtime-promoted-secret',
        isSecret: true,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
    }))

    assertEquals(result.secretPlan.length, 1)
    assertEquals(result.secretPlan[0]?.forRuntime, true)
    assertEquals(result.secretPlan[0]?.forBuild, true)
    const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
    const env = api.environment as Record<string, string>
    assertEquals(env.DB_PASS, undefined)
    assertEquals(env.DB_PASS_FILE, secretContainerPath('DB_PASS'))
    const build = api.build as {
      args: Record<string, string>
      secrets: Array<{ source: string }>
    }
    assertEquals(build.args, { STAGE: 'prod' })
    assertEquals(build.secrets.length, 1)
    assertEquals((api.secrets as unknown[]).length, 1)
  })

  it('normalizes list-form environment KEY:value, mixed separators, and skips non-strings', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      web: {
        image: 'nginx',
        environment: [12, 'PORT:3000', 'MIXED=keep:tail', 'BARE'],
      },
    }
    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [],
      perServiceEntries: new Map(),
    }))
    const env = (result.document.data.services as Record<string, Record<string, unknown>>)
      .web.environment as Record<string, string>
    assertEquals(env.PORT, '3000')
    assertEquals(env.MIXED, 'keep:tail')
    assertEquals(env.BARE, '')
    assertEquals('12' in env, false)
  })

  it('skips services that are not mappings and treats a non-mapping services value as empty', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      web: 'not-a-mapping',
      api: { image: 'node:22' },
    }
    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'PORT',
        value: '3000',
        isSecret: false,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
    }))
    const services = result.document.data.services as Record<string, unknown>
    assertEquals(services.web, 'not-a-mapping')
    assertEquals(
      (services.api as { environment: { PORT: string } }).environment.PORT,
      composeInterpolationRef(serviceEnvInterpolationKey('api', 'PORT')),
    )

    const emptyServices = emptyComposeDocument()
    emptyServices.data.services = ['web']
    const skipped = mustApply(applyVariablesToComposeDocument(emptyServices, {
      globalEntries: [],
      perServiceEntries: new Map(),
    }))
    assertEquals(skipped.document.data.services, {})
  })

  it('collects scoped secrets and rejects ${SECRET} interpolation from a scope map', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      web: { image: 'nginx', environment: { X: '${SCOPE_SECRET}' } },
    }
    const result = applyVariablesToComposeDocument(doc, {
      globalEntries: [],
      perServiceEntries: new Map(),
      perServiceScopes: new Map([
        ['web', {
          environment: undefined,
          organization: new Map([
            ['SCOPE_SECRET', {
              key: 'SCOPE_SECRET',
              value: 'scoped-secret',
              isSecret: true,
              isLiteral: false,
              forBuild: false,
              forRuntime: true,
            }],
          ]),
        }],
      ]),
    })
    if (!isApplyVariablesError(result)) {
      throw new TypeError('expected secret interpolation error')
    }
    assertEquals(result.kind, 'variable_secret_interpolation')
  })

  it('clears empty build.args after resolving the last secret ref', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      api: {
        image: 'node:22',
        build: { args: { TOKEN: '{$TOKEN}' } },
      },
    }
    const result = mustApply(applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'TOKEN',
        value: 'only-arg',
        isSecret: true,
        isLiteral: false,
        forBuild: true,
        forRuntime: false,
      }],
      perServiceEntries: new Map(),
    }))
    const build = (result.document.data.services as Record<string, Record<string, unknown>>)
      .api.build as { args?: Record<string, string>; secrets: unknown[] }
    assertEquals(build.args, undefined)
    assertEquals(build.secrets.length, 1)
  })
})
