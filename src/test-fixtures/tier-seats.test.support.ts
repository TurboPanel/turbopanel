import { eq } from 'drizzle-orm'
import type { createDenoDb } from '../db/connection.ts'
import { payer, subscription, subscriptionItem, tier } from '../db/schema.ts'
import { getTierByLabel, insertTier } from '../features/tiers/tier-records.ts'

type TestDb = ReturnType<typeof createDenoDb>

/** S1 licenses bought for one organization, and how to take them away again. */
export type SeededTierSeats = Readonly<{
  tierId: string
  /** Drop the subscription, its payer and any tier this seeding created. */
  cleanup: () => Promise<void>
}>

/**
 * Give an organization `seats` paid S1 licenses (an active subscription with
 * one S1 item), creating the S1 tier when the database has none yet.
 */
export async function seedTierSeats(
  db: TestDb,
  organizationId: string,
  seats: number
): Promise<SeededTierSeats> {
  const createdTiers: string[] = []
  let tierId = (await getTierByLabel(db, 'S1'))?.id
  if (!tierId) {
    const row = await insertTier(db, {
      label: 'S1',
      providerProductId: 'prod_add_server_s1',
      priceCents: null,
      currency: null,
    })
    createdTiers.push(row.id)
    tierId = row.id
  }
  const [payerRow] = await db
    .insert(payer)
    .values({
      organizationId,
      provider: 'stripe',
      providerCustomerId: `cus_${crypto.randomUUID()}`,
    })
    .returning({ id: payer.id })
  const [subRow] = await db
    .insert(subscription)
    .values({
      payerId: payerRow!.id,
      providerSubscriptionId: `sub_add_server_${crypto.randomUUID()}`,
      status: 'active',
      providerStatus: 'active',
    })
    .returning({ id: subscription.id })
  await db.insert(subscriptionItem).values({
    subscriptionId: subRow!.id,
    tierId,
    providerItemId: `si_${crypto.randomUUID()}`,
    providerPriceId: `price_${crypto.randomUUID()}`,
    quantity: seats,
  })
  return {
    tierId,
    cleanup: async () => {
      await db.delete(subscriptionItem).where(eq(subscriptionItem.subscriptionId, subRow!.id))
      await db.delete(subscription).where(eq(subscription.id, subRow!.id))
      await db.delete(payer).where(eq(payer.id, payerRow!.id))
      for (const id of createdTiers) await db.delete(tier).where(eq(tier.id, id))
    },
  }
}
