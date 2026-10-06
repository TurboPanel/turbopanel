import { assertEquals } from '@std/assert'
import {
  collectHostingExtensionValidationIssues,
  HOSTING_ENTRY_KEYS,
  HOSTING_WWW_MODE_MESSAGE,
  parseHostingExtensionEntries,
} from './hosting-extension.ts'

const test = Deno.test.bind(Deno)

const BASE = 'services.web.x-turbopanel'
const MODES = ['both', 'www-to-root', 'root-to-www'] as const

function issuesFor(entry: Record<string, unknown>) {
  return collectHostingExtensionValidationIssues(BASE, [entry], 'container')
}

test('www is an allowed hosting entry key', () => {
  assertEquals(HOSTING_ENTRY_KEYS.has('www'), true)
})

test('parse keeps each www mode other than off', () => {
  for (const www of MODES) {
    assertEquals(parseHostingExtensionEntries([{ hostname: 'example.com', www }]), [
      { hostname: 'example.com', www },
    ])
  }
})

test('parse drops www when it is off or not a mode, and keeps the entry', () => {
  for (const www of ['off', 'yes', true, 1, null, 'WWW-TO-ROOT']) {
    assertEquals(parseHostingExtensionEntries([{ hostname: 'example.com', www }]), [
      { hostname: 'example.com' },
    ])
  }
})

test('a value outside the four modes is an issue on the www path', () => {
  for (const www of ['yes', true, 1, null, 'WWW-TO-ROOT']) {
    assertEquals(issuesFor({ hostname: 'example.com', www }), [
      { path: `${BASE}.hosting[0].www`, message: HOSTING_WWW_MODE_MESSAGE },
    ])
  }
})

test('a wildcard hostname with a www mode other than off is an issue', () => {
  for (const www of MODES) {
    assertEquals(issuesFor({ hostname: '*.example.com', www }), [
      {
        path: `${BASE}.hosting[0].www`,
        message: '*.example.com has no www or bare spelling, so www must be "off" for it',
      },
    ])
  }
  assertEquals(issuesFor({ hostname: '*.example.com', www: 'off' }), [])
})

test('every mode is fine on a plain or www hostname', () => {
  for (const www of ['off', ...MODES]) {
    assertEquals(issuesFor({ hostname: 'example.com', www }), [])
    assertEquals(issuesFor({ hostname: 'www.example.com', www }), [])
  }
})
