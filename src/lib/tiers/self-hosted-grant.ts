/**
 * The self-hosted entitlement grant — how a free instance holds licenses.
 *
 * Self-hosted TurboPanel is free software: nothing is metered and nothing
 * is billed, so there is no payer, no subscription and no seat row to
 * derive an entitlement from. But the *licensing machinery* is not
 * hosted-only — a server is still licensed, still placed on a tier, and
 * still carries `server.assigned_tier_id`. Without a quantity to assign
 * from, every self-hosted server would be uncovered, which is exactly what
 * a control plane moved from Deno to Workers (or a development instance
 * switched between the two runtimes) discovers the hard way: its daemons
 * are refused with `License tier below required`.
 *
 * The grant closes that. On the self-hosted runtime every active license
 * is matched by one **granted** unit at `SX` — the custom rung, which
 * watches every slot the daemon can monitor and has no ceiling on cores or
 * RAM, so it covers any machine anyone attaches. It is not a purchase: it
 * bills nothing, it is never an item on a provider subscription, and the
 * console never renders it as a tier line. It is simply the quantity the
 * assignment needs in order to be the same code on both runtimes.
 *
 * **Storage is the `self_hosted_grant` table**, one row per organization
 * (schema-child-tables, Road-to-0.1.x — promoted out of a `setting` row
 * keyed `SELF_HOSTED_GRANT:<organizationId>`), and, decisively, *not* a
 * `seat` row. The Stripe mutation surface builds `items[]` from
 * `state.seats`, so a grant can never leak into a provider call; and
 * `payer` / `subscription` / `seat` stay what `src/lib/billing/AGENTS.md`
 * says they are — a projection of the provider's customer, written only by
 * the webhook ingress.
 *
 * This module is **pure**, so `src/lib/db/billing-records.ts` can read the
 * grant into `OrganizationBillingState` without importing back into the
 * tier tree. The reads and writes live in `self-hosted-grant-records.ts`.
 */

import { CUSTOM_TIER_LABEL, ladderEntry } from './ladder.ts'

/**
 * What a self-hosted organization is entitled to without buying anything:
 * `quantity` units at the custom tier. The tier id is stored rather than
 * looked up by label on every read, because the entitlement readers are on
 * the ingest and page-load path and must not add a query.
 */
export type SelfHostedGrant = Readonly<{
  tierId: string
  quantity: number
}>

/** The rank the grant assigns at — `SX`, the top of the ladder. */
export function selfHostedGrantRank(): number {
  const entry = ladderEntry(CUSTOM_TIER_LABEL)
  if (!entry) throw new Error(`${CUSTOM_TIER_LABEL} is not on the ladder`)
  return entry.rank
}
