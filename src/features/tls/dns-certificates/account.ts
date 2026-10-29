/**
 * The certificate-authority account an organization orders with: one per
 * organization and one per directory (staging and production never share),
 * created on the first order and used by every later order and every renewal.
 *
 * The key is sealed in `secret` (provider `acme_account`, `name` is the
 * directory); the account address, which is not secret, sits in the row's
 * `metadata`. A unique index on (organization, name) for these rows makes the
 * first insert race-safe: two first orders at once both read back the same row
 * and so the same key. Registering is safe to repeat too, because the authority
 * answers a key it already knows with the account it already made.
 */
import { and, eq, sql } from 'drizzle-orm'
import { secret } from '../../../db/schema.ts'
import { AcmeClient } from '../../../lib/acme/client.ts'
import { acmeDirectoryUrl } from '../../../lib/acme/directories.ts'
import { generateAccountKeyPem, importAccountKey } from '../../../lib/acme/jws.ts'
import { decryptSecret, encryptSecret } from '../../../lib/secrets/data-encryption.ts'
import type { DnsCertContext } from './context.ts'

export const ACME_ACCOUNT_SECRET_PROVIDER = 'acme_account'

export type OrgAccount = {
  client: AcmeClient
  /** The sealed account key, kept with an open order so it can finish on its own. */
  sealedKey: string
  accountUrl: string
}

const directoryName = (staging: boolean) => (staging ? 'staging' : 'production')

async function readRow(ctx: DnsCertContext, organizationId: string, staging: boolean) {
  const [row] = await ctx.db
    .select()
    .from(secret)
    .where(
      and(
        eq(secret.organizationId, organizationId),
        eq(secret.provider, ACME_ACCOUNT_SECRET_PROVIDER),
        eq(secret.name, directoryName(staging))
      )
    )
    .limit(1)
  return row ?? null
}

/** Insert the account row if there is none; whoever loses the race reads the winner's. */
async function ensureRow(ctx: DnsCertContext, organizationId: string, staging: boolean) {
  const found = await readRow(ctx, organizationId, staging)
  if (found) return found
  const sealed = await encryptSecret(ctx.secrets, await generateAccountKeyPem())
  await ctx.db
    .insert(secret)
    .values({
      organizationId,
      provider: ACME_ACCOUNT_SECRET_PROVIDER,
      name: directoryName(staging),
      secretEnvelope: sealed,
      metadata: {},
    })
    .onConflictDoNothing({
      target: [secret.organizationId, secret.name],
      where: sql`${secret.provider} = 'acme_account'`,
    })
  const row = await readRow(ctx, organizationId, staging)
  if (!row) throw new Error('The certificate account was not created')
  return row
}

function storedUrl(metadata: unknown): string | null {
  const url = (metadata as { accountUrl?: unknown } | null)?.accountUrl
  return typeof url === 'string' && url.length > 0 ? url : null
}

/** A new key for the account (the authority stopped accepting the old one); it is registered again on use. */
async function replaceKey(ctx: DnsCertContext, id: string): Promise<void> {
  const sealed = await encryptSecret(ctx.secrets, await generateAccountKeyPem())
  await ctx.db.update(secret).set({ secretEnvelope: sealed, metadata: {} }).where(eq(secret.id, id))
}

/**
 * The organization's account for one directory, registered on first use.
 * `replace` starts over with a new key, for an account the authority no longer
 * accepts.
 */
export async function orgAccount(
  ctx: DnsCertContext,
  organizationId: string,
  staging: boolean,
  options: { replace?: boolean } = {}
): Promise<OrgAccount> {
  let row = await ensureRow(ctx, organizationId, staging)
  if (options.replace) {
    await replaceKey(ctx, row.id)
    row = await ensureRow(ctx, organizationId, staging)
  }
  const keyPem = await decryptSecret(ctx.secrets, row.secretEnvelope)
  const known = storedUrl(row.metadata)
  const client = new AcmeClient({
    directoryUrl: acmeDirectoryUrl(staging),
    key: await importAccountKey(keyPem),
    accountUrl: known,
    fetch: ctx.acmeFetch,
  })
  const accountUrl = await client.ensureAccount()
  if (accountUrl !== known) {
    await ctx.db.update(secret).set({ metadata: { accountUrl } }).where(eq(secret.id, row.id))
  }
  return { client, sealedKey: row.secretEnvelope, accountUrl }
}
