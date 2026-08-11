import { describe, it } from '@std/testing/bdd'
import { assertEquals } from '@std/assert'
import {
  applyVariablesToComposeDocument,
  DEPLOY_PREVIEW_SECRET_PLACEHOLDER,
  escapeLiteralComposeValue,
  injectSecretPlaceholdersIntoComposeDocument,
  trimVariableValue,
} from './apply-variables.ts'
import { emptyComposeDocument } from './types.ts'

describe('apply-variables', () => {
  it('trims variable values on edges only', () => {
    assertEquals(trimVariableValue('  hello\nworld  '), 'hello\nworld')
  })

  it('escapes dollar signs for literal compose values', () => {
    assertEquals(escapeLiteralComposeValue('$FOO'), '$$FOO')
  })

  it('injects runtime variables into compose services', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      web: { image: 'nginx:latest' },
    }

    const result = applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'PORT',
        value: '3000',
        isSecret: false,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
    })

    const services = result.document.data.services as Record<string, Record<string, unknown>>
    assertEquals(services.web.environment, { PORT: '3000' })
    assertEquals(result.secretMaterial.length, 0)
  })

  it('routes secrets to secretMaterial instead of compose yaml', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { api: { image: 'node:22' } }

    const result = applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'SECRET',
        value: 'tpsecret.v1.test',
        isSecret: true,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
    })

    const services = result.document.data.services as Record<string, Record<string, unknown>>
    assertEquals(services.api.environment, undefined)
    assertEquals(result.secretMaterial.length, 1)
  })

  it('injects masked placeholders for secret material in preview YAML', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { api: { image: 'node:22' } }

    const applied = applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'SECRET',
        value: 'tpsecret.v1.test',
        isSecret: true,
        isLiteral: false,
        forBuild: true,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
    })

    const preview = injectSecretPlaceholdersIntoComposeDocument(
      applied.document,
      applied.secretMaterial,
    )
    const services = preview.data.services as Record<string, Record<string, unknown>>
    const env = services.api.environment as Record<string, string>
    const build = services.api.build as { args: Record<string, string> }
    assertEquals(env.SECRET, DEPLOY_PREVIEW_SECRET_PLACEHOLDER)
    assertEquals(build.args.SECRET, DEPLOY_PREVIEW_SECRET_PLACEHOLDER)
  })

  it('merges per-service entries over globals and preserves existing env', () => {
    const doc = emptyComposeDocument()
    doc.data.services = {
      api: { image: 'node:22', environment: { EXISTING: 'keep' } },
      worker: { image: 'busybox' },
    }

    const result = applyVariablesToComposeDocument(doc, {
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
    })

    const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
    assertEquals(api.environment, { EXISTING: 'keep', GLOBAL: 'all', API_ONLY: 'api' })
    const worker = (result.document.data.services as Record<string, Record<string, unknown>>).worker!
    assertEquals(worker.environment, { GLOBAL: 'all' })
  })

  it('injectSecretPlaceholdersIntoComposeDocument is a no-op without secrets', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { api: { image: 'node:22' } }
    assertEquals(injectSecretPlaceholdersIntoComposeDocument(doc, []), doc)
  })

  it('applies build-only literal variables into build args', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { api: { image: 'node:22', environment: { KEEP: 'yes' } } }

    const result = applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'BUILD_ARG',
        value: '$SECRET',
        isSecret: false,
        isLiteral: true,
        forBuild: true,
        forRuntime: false,
      }],
      perServiceEntries: new Map(),
    })

    const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
    assertEquals(api.environment, { KEEP: 'yes' })
    assertEquals((api.build as { args: Record<string, string> }).args.BUILD_ARG, '$$SECRET')
  })

  it('preserves existing environment when no runtime entries are provided', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { api: { image: 'node:22', environment: { OLD: 'gone' } } }

    const result = applyVariablesToComposeDocument(doc, {
      globalEntries: [],
      perServiceEntries: new Map(),
    })

    const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
    assertEquals(api.environment, { OLD: 'gone' })
  })

  it('skips non-mapping service entries', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { bad: 'not-a-map', api: { image: 'node:22' } }

    const result = applyVariablesToComposeDocument(doc, {
      globalEntries: [{
        key: 'PORT',
        value: '3000',
        isSecret: false,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      }],
      perServiceEntries: new Map(),
    })

    const api = (result.document.data.services as Record<string, Record<string, unknown>>).api!
    assertEquals(api.environment, { PORT: '3000' })
  })

  it('injectSecretPlaceholders skips entries without composeServiceName', () => {
    const doc = emptyComposeDocument()
    doc.data.services = { api: { image: 'node:22' } }
    const unchanged = injectSecretPlaceholdersIntoComposeDocument(doc, [{
      key: 'SECRET',
      composeServiceName: null,
      forBuild: true,
      forRuntime: true,
      isLiteral: false,
      valueEnvelope: 'tpsecret.v1.test',
    }])
    assertEquals(unchanged, doc)
  })
})
