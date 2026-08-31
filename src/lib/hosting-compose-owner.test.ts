import { assertEquals } from '@std/assert'
import {
  isAdoptedComposeHosting,
  isComposeOwnedHosting,
  readHostingComposeOwner,
  withHostingComposeOwner,
  withoutHostingComposeOwner,
} from './hosting-compose-owner.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('an adopted row is marked, and reads back as adopted', () => {
  const metadata = withHostingComposeOwner({ note: 'kept' }, {
    composeServiceName: 'web',
    route: 'app.example.com /',
    tlsMode: 'internal',
    adopted: true,
  })
  assertEquals(metadata.note, 'kept')
  assertEquals(isComposeOwnedHosting(metadata), true)
  assertEquals(isAdoptedComposeHosting(metadata), true)
  assertEquals(readHostingComposeOwner(metadata), {
    composeServiceName: 'web',
    route: 'app.example.com /',
    tlsMode: 'internal',
    adopted: true,
  })
})

test('the adopted marker is sticky across re-assertions', () => {
  const first = withHostingComposeOwner(null, {
    composeServiceName: 'web',
    route: 'app.example.com /',
    adopted: true,
  })
  // A later reconcile re-asserts without knowing it was an adoption.
  const second = withHostingComposeOwner(first, {
    composeServiceName: 'web',
    route: 'app.example.com /',
    tlsMode: 'certificate',
  })
  assertEquals(isAdoptedComposeHosting(second), true)
})

test('a row compose minted itself is never marked adopted', () => {
  const metadata = withHostingComposeOwner(null, {
    composeServiceName: 'web',
    route: 'app.example.com /',
  })
  assertEquals(isAdoptedComposeHosting(metadata), false)
  assertEquals(readHostingComposeOwner(metadata)?.adopted, undefined)
})

test('releasing strips every compose key and keeps operator metadata', () => {
  const owned = withHostingComposeOwner({ note: 'kept' }, {
    composeServiceName: 'web',
    route: 'app.example.com /',
    tlsMode: 'internal',
    adopted: true,
  })
  const released = withoutHostingComposeOwner(owned)
  assertEquals(released, { note: 'kept' })
  assertEquals(isComposeOwnedHosting(released), false)
  assertEquals(readHostingComposeOwner(released), null)
})
