import { describe, it } from '@std/testing/bdd'
import { assertEquals } from '@std/assert'
import {
  applyVariablesToComposeDocument,
  escapeLiteralComposeValue,
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
})
