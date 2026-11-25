import { assert, assertEquals } from '@std/assert'
import { base64urlEncode } from '../lib/encoding/base64url.ts'
import { openFromSender } from '../lib/panel-identity/hpke.ts'
import { HPKE_TEST_RECIPIENT_SEED, hpkeTestRecipient } from '../test-fixtures/hpke-vector.ts'
import {
  parseSealingKeyRegistration,
  registerDaemonSealingKey,
  SEALING_KEY_SIGNATURE_PREFIX,
  type SealingKeyRegistrationStore,
} from './sealing-key-registration.ts'
import {
  sealDecryptAnswers,
  type DaemonSealingKey,
} from '../features/servers/daemon-sealing-key.ts'

const test = Deno.test.bind(Deno)

const SERVER_ID = 'srv_sealing_test'
const DECRYPTED_SAMPLE = 'correct horse battery staple'

async function daemonKeys(): Promise<{
  publicJwk: JsonWebKey
  sign: (text: string) => Promise<string>
}> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  return {
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    sign: async (text) =>
      base64urlEncode(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'Ed25519' },
            pair.privateKey,
            new TextEncoder().encode(text)
          )
        )
      ),
  }
}

async function registrationBody(sign: (text: string) => Promise<string>) {
  const recipient = await hpkeTestRecipient()
  const pub = base64urlEncode(recipient.pub)
  return { kid: recipient.kid, pub, sig: await sign(SEALING_KEY_SIGNATURE_PREFIX + pub) }
}

function memoryStore(publicJwk: JsonWebKey | null) {
  const saved: Array<DaemonSealingKey & { reportedAt: string }> = []
  const store: SealingKeyRegistrationStore = {
    loadDaemonPublicJwk: () => Promise.resolve(publicJwk),
    save: (_id, key) => {
      saved.push(key)
      return Promise.resolve()
    },
  }
  return { store, saved }
}

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const originals = new Map<string, unknown>()
  for (const name of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    originals.set(name, console[name])
    console[name] = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
  }
  return {
    lines,
    restore: () => {
      for (const [name, original] of originals) {
        ;(console as unknown as Record<string, unknown>)[name] = original
      }
    },
  }
}

test('parseSealingKeyRegistration enforces 43-character kid and pub and a bounded signature', () => {
  const ok = { kid: 'A'.repeat(43), pub: 'B'.repeat(43), sig: 'C'.repeat(86) }
  assertEquals(parseSealingKeyRegistration(ok), ok)
  assertEquals(parseSealingKeyRegistration({ ...ok, kid: 'short' }), null)
  assertEquals(parseSealingKeyRegistration({ ...ok, pub: 'B'.repeat(44) }), null)
  assertEquals(parseSealingKeyRegistration({ ...ok, sig: 'C'.repeat(129) }), null)
  assertEquals(parseSealingKeyRegistration({ ...ok, sig: '' }), null)
  assertEquals(parseSealingKeyRegistration(null), null)
})

test('a valid registration is stored; a bad signature or wrong key id changes nothing', async () => {
  const daemon = await daemonKeys()
  const body = await registrationBody(daemon.sign)
  const accepted = memoryStore(daemon.publicJwk)
  const result = await registerDaemonSealingKey(accepted.store, SERVER_ID, body)
  assertEquals(result.status, 200)
  assertEquals(accepted.saved.length, 1)
  assertEquals(accepted.saved[0].kid, body.kid)

  const other = await daemonKeys()
  const wrongSigner = memoryStore(other.publicJwk)
  assertEquals((await registerDaemonSealingKey(wrongSigner.store, SERVER_ID, body)).status, 400)
  assertEquals(wrongSigner.saved.length, 0)

  const wrongKid = memoryStore(daemon.publicJwk)
  const forged = { ...body, kid: 'D'.repeat(43) }
  assertEquals((await registerDaemonSealingKey(wrongKid.store, SERVER_ID, forged)).status, 400)
  assertEquals(wrongKid.saved.length, 0)

  const unknownServer = memoryStore(null)
  assertEquals((await registerDaemonSealingKey(unknownServer.store, SERVER_ID, body)).status, 400)
  assertEquals(unknownServer.saved.length, 0)
})

test('decrypt answers are sealed to the registered key, never plaintext', async () => {
  const recipient = await hpkeTestRecipient()
  const key = { kid: recipient.kid, pub: base64urlEncode(recipient.pub) }
  const sealed = await sealDecryptAnswers([DECRYPTED_SAMPLE, null], SERVER_ID, key)
  assertEquals(sealed.length, 2)
  assertEquals(sealed[1], null)
  const opened = await openFromSender(HPKE_TEST_RECIPIENT_SEED, SERVER_ID, sealed[0]!)
  assertEquals(new TextDecoder().decode(opened), DECRYPTED_SAMPLE)
  assert(!JSON.stringify(sealed).includes(DECRYPTED_SAMPLE))
})

test('sealing and registering write no plaintext or key material to the console', async () => {
  const daemon = await daemonKeys()
  const body = await registrationBody(daemon.sign)
  const recipient = await hpkeTestRecipient()
  const key = { kid: recipient.kid, pub: base64urlEncode(recipient.pub) }
  const capture = captureConsole()
  try {
    await registerDaemonSealingKey(memoryStore(daemon.publicJwk).store, SERVER_ID, body)
    await registerDaemonSealingKey(memoryStore(daemon.publicJwk).store, SERVER_ID, {
      ...body,
      sig: 'x'.repeat(86),
    })
    await sealDecryptAnswers([DECRYPTED_SAMPLE], SERVER_ID, key)
  } finally {
    capture.restore()
  }
  const output = capture.lines.join('\n')
  for (const sensitive of [
    DECRYPTED_SAMPLE,
    body.pub,
    body.sig,
    base64urlEncode(HPKE_TEST_RECIPIENT_SEED),
  ]) {
    assert(!output.includes(sensitive))
  }
})
