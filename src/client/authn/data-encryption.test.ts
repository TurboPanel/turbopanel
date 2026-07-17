import { describe, expect, it } from 'vitest'
import {
  DataEncryptionError,
  decryptSecret,
  decryptSecretForDaemon,
  encryptSecret,
  encryptSecretForDaemon,
  generateSealedSecret,
  isDaemonSealedEnvelope,
  isSealedEnvelope,
  parseDaemonSecretEnvelope,
  parseSecretEnvelope,
  resealSecretForDaemon,
} from './data-encryption.ts'
import {
  deriveEncryptionSecretsConfig,
  parseSecretsEnv,
} from './secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const V2_SECRET = 'Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6Qq7'
const V1_SECRET = TEST_ONLY_TURBOPANEL_SECRET

async function createCurrentSecrets() {
  const config = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  return deriveEncryptionSecretsConfig(config, 'data-encryption')
}

async function createRotatedSecrets() {
  const config = parseSecretsEnv(
    undefined,
    `2:${V2_SECRET},1:${V1_SECRET}`,
    'deno',
  )
  return deriveEncryptionSecretsConfig(config, 'data-encryption')
}

async function createV1OnlySecrets() {
  const config = parseSecretsEnv(undefined, `1:${V1_SECRET}`, 'deno')
  return deriveEncryptionSecretsConfig(config, 'data-encryption')
}

async function createSecretsConfig() {
  return parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
}

describe('encryptSecretForDaemon / decryptSecretForDaemon', () => {
  const recipient = {
    serverId: '11111111-1111-4111-8111-111111111111',
    keyId: '22222222-2222-4222-8222-222222222222',
  }

  it('round-trips plaintext for the bound recipient', async () => {
    const secretsConfig = await createSecretsConfig()
    const envelope = await encryptSecretForDaemon(secretsConfig, recipient, 'daemon-bound')
    expect(isDaemonSealedEnvelope(envelope)).toBe(true)
    expect(parseDaemonSecretEnvelope(envelope)).toEqual({
      ...recipient,
      keyVersion: 1,
    })
    expect(await decryptSecretForDaemon(secretsConfig, recipient, envelope)).toBe('daemon-bound')
  })

  it('rejects decryption for a different daemon JWT recipient', async () => {
    const secretsConfig = await createSecretsConfig()
    const envelope = await encryptSecretForDaemon(secretsConfig, recipient, 'daemon-bound')
    await expect(
      decryptSecretForDaemon(
        secretsConfig,
        { serverId: recipient.serverId, keyId: 'other-key-id' },
        envelope,
      ),
    ).rejects.toThrow(DataEncryptionError)
  })
})

describe('encryptSecret / decryptSecret', () => {
  it('round-trips plaintext', async () => {
    const secrets = await createCurrentSecrets()
    const envelope = await encryptSecret(secrets, 'hello-secret')
    expect(isSealedEnvelope(envelope)).toBe(true)
    expect(await decryptSecret(secrets, envelope)).toBe('hello-secret')
  })

  it('decrypts with rotation fallbacks (v2 current, v1 fallback)', async () => {
    const rotated = await createRotatedSecrets()
    const envelope = await encryptSecret(rotated, 'rotated-value')
    expect(await decryptSecret(rotated, envelope)).toBe('rotated-value')

    const v1Only = await createV1OnlySecrets()
    const v1Envelope = await encryptSecret(v1Only, 'v1-key-version-value')
    expect(await decryptSecret(rotated, v1Envelope)).toBe('v1-key-version-value')
  })

  it('reseals to current key version on write after rotation', async () => {
    const v1Only = await createV1OnlySecrets()
    const rotated = await createRotatedSecrets()
    const v1Envelope = await encryptSecret(v1Only, 'rotate-me')
    expect(parseSecretEnvelope(v1Envelope)).toEqual({ keyVersion: 1 })

    const plaintext = await decryptSecret(rotated, v1Envelope)
    const resealed = await encryptSecret(rotated, plaintext)
    expect(parseSecretEnvelope(resealed)).toEqual({
      keyVersion: rotated.current.version,
    })
    expect(rotated.current.version).toBe(2)
    expect(resealed).not.toBe(v1Envelope)
    expect(await decryptSecret(rotated, resealed)).toBe('rotate-me')
  })

  it('rejects unknown key version without trial decryption', async () => {
    const secrets = await createCurrentSecrets()
    const envelope = await encryptSecret(secrets, 'x')
    const tamperedVersion = envelope.replace(/\.1\./, '.99.')
    await expect(decryptSecret(secrets, tamperedVersion)).rejects.toThrow(
      DataEncryptionError,
    )
  })

  it('rejects malformed envelopes', async () => {
    const secrets = await createCurrentSecrets()
    await expect(decryptSecret(secrets, 'tpsecret.v1')).rejects.toThrow(
      DataEncryptionError,
    )
    await expect(decryptSecret(secrets, 'not-sealed')).rejects.toThrow(
      DataEncryptionError,
    )
  })

  it('rejects tampered ciphertext', async () => {
    const secrets = await createCurrentSecrets()
    const envelope = await encryptSecret(secrets, 'tamper-me')
    const parts = envelope.split('.')
    parts[4] = `${parts[4].slice(0, -2)}xx`
    await expect(decryptSecret(secrets, parts.join('.'))).rejects.toThrow(
      DataEncryptionError,
    )
  })
})

describe('resealSecretForDaemon', () => {
  const recipient = {
    serverId: '11111111-1111-4111-8111-111111111111',
    keyId: '22222222-2222-4222-8222-222222222222',
  }

  it('reseals tpsecret → tpdaemon for the bound recipient', async () => {
    const secretsConfig = await createSecretsConfig()
    const dataEncryptionSecrets = await createCurrentSecrets()
    const tpsecret = await encryptSecret(dataEncryptionSecrets, 'delivery-secret')
    const tpdaemon = await resealSecretForDaemon(
      secretsConfig,
      dataEncryptionSecrets,
      recipient,
      tpsecret,
    )
    expect(isDaemonSealedEnvelope(tpdaemon)).toBe(true)
    expect(await decryptSecretForDaemon(secretsConfig, recipient, tpdaemon)).toBe(
      'delivery-secret',
    )
  })
})

describe('generateSealedSecret', () => {
  it('returns plaintext and a tpsecret envelope that decrypts to it', async () => {
    const dataEncryptionSecrets = await createCurrentSecrets()
    const { plaintext, sealed } = await generateSealedSecret(dataEncryptionSecrets)
    expect(plaintext.length).toBeGreaterThan(0)
    expect(sealed.startsWith('tpsecret.v1.')).toBe(true)
    expect(await decryptSecret(dataEncryptionSecrets, sealed)).toBe(plaintext)
  })

  it('principal-password sealing stores tpsecret never plaintext', async () => {
    // Mirrors POST /principals/:id/password { generate: true } persist path.
    const dataEncryptionSecrets = await createCurrentSecrets()
    const { plaintext, sealed } = await generateSealedSecret(dataEncryptionSecrets)
    expect(sealed.startsWith('tpsecret.v1.')).toBe(true)
    expect(sealed.includes(plaintext)).toBe(false)
    expect(await decryptSecret(dataEncryptionSecrets, sealed)).toBe(plaintext)
  })
})

describe('isSealedEnvelope', () => {
  it('returns true for tpsecret envelopes', async () => {
    const secrets = await createCurrentSecrets()
    const envelope = await encryptSecret(secrets, 'x')
    expect(isSealedEnvelope(envelope)).toBe(true)
  })

  it('returns false for plaintext and unrelated strings', () => {
    expect(isSealedEnvelope('plain-password')).toBe(false)
    expect(isSealedEnvelope('')).toBe(false)
    expect(isSealedEnvelope('tpsecret')).toBe(false)
  })
})
