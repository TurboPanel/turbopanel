/**
 * The control plane's own ACME account for DNS-01 orders. Its key is stored
 * sealed in the `INSTANCE_ACME_ACCOUNT` setting, apart from every
 * organization account. Contact, terms and directory come from the existing
 * instance certificate settings (Admin › Access › Certificates).
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../../../db/connection.ts'
import { setting } from '../../../../db/schema.ts'
import {
  INSTANCE_ACME_ACCOUNT_SETTING_KEY,
  LETS_ENCRYPT_DIRECTORY_URL,
  LETS_ENCRYPT_STAGING_DIRECTORY_URL,
  type ResolvedInstanceAcmeSettings,
} from '../../../../features/install/instance-acme-settings.ts'
import { AcmeClient } from '../../../../lib/acme/client.ts'
import { generateAccountKeyPem, importAccountKey } from '../../../../lib/acme/jws.ts'
import { decryptSecret, encryptSecret } from '../../../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../../../lib/secrets/secrets.ts'
import { Dns01AccountError } from './backoff.ts'

type StoredAccount = { v: 1; directory: string; kid: string | null; sealed: string }

export const TERMS_NOT_ACCEPTED =
  'Accept the certificate authority terms in Admin › Access › Certificates.'

/** Staging replaces only the default production directory; a custom directory is used as set. */
export function dns01Directory(
  settings: Pick<ResolvedInstanceAcmeSettings, 'directoryUrl' | 'useStaging'>
): string {
  const isDefault = settings.directoryUrl === LETS_ENCRYPT_DIRECTORY_URL
  return settings.useStaging && isDefault
    ? LETS_ENCRYPT_STAGING_DIRECTORY_URL
    : settings.directoryUrl
}

function readStored(value: unknown): StoredAccount | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Partial<StoredAccount>
  if (raw.v !== 1 || typeof raw.directory !== 'string' || typeof raw.sealed !== 'string')
    return null
  return {
    v: 1,
    directory: raw.directory,
    kid: typeof raw.kid === 'string' ? raw.kid : null,
    sealed: raw.sealed,
  }
}

async function loadStored(db: Db): Promise<StoredAccount | null> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, INSTANCE_ACME_ACCOUNT_SETTING_KEY))
    .limit(1)
  return readStored(rows[0]?.value)
}

async function saveStored(db: Db, value: StoredAccount): Promise<void> {
  await db
    .insert(setting)
    .values({ key: INSTANCE_ACME_ACCOUNT_SETTING_KEY, value })
    .onConflictDoUpdate({
      target: setting.key,
      set: { value, updatedAt: new Date().toISOString() },
    })
}

export type InstanceAcmeAccountDeps = {
  dataEncryption: DerivedSecretsConfig
  fetch: typeof fetch
  settings: ResolvedInstanceAcmeSettings
}

/**
 * A ready client for the configured directory: the stored account when it
 * belongs to that directory, otherwise a new key registered once. Refuses
 * with `Dns01AccountError` while the terms are not accepted.
 */
export async function instanceAcmeClient(
  db: Db,
  deps: InstanceAcmeAccountDeps
): Promise<AcmeClient> {
  if (!deps.settings.tosAccepted) throw new Dns01AccountError(TERMS_NOT_ACCEPTED)
  const directory = dns01Directory(deps.settings)
  const stored = await loadStored(db)
  const current = stored?.directory === directory ? stored : null
  const pem = current
    ? await decryptSecret(deps.dataEncryption, current.sealed)
    : await generateAccountKeyPem()
  const client = new AcmeClient({
    directoryUrl: directory,
    key: await importAccountKey(pem),
    accountUrl: current?.kid ?? null,
    fetch: deps.fetch,
  })
  if (current?.kid) return client
  const email = deps.settings.contactEmail
  const kid = await client.ensureAccount(email ? [`mailto:${email}`] : [])
  const sealed = current?.sealed ?? (await encryptSecret(deps.dataEncryption, pem))
  await saveStored(db, { v: 1, directory, kid, sealed })
  return client
}

/** Forget the account so the next order registers again (the authority said it is gone). */
export async function forgetInstanceAcmeAccount(db: Db): Promise<void> {
  await db.delete(setting).where(eq(setting.key, INSTANCE_ACME_ACCOUNT_SETTING_KEY))
}
