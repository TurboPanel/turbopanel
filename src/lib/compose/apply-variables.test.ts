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
})
