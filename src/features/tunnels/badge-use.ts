/**
 * Doing a provider call with the right API token. One account can hold several
 * tokens (one for tunnels, others for DNS limited to some zones), so each call
 * names what it needs and `useBadges` tries the qualifying tokens best first,
 * narrowest first. When the provider refuses a write (a read probe once passed,
 * the edit right was never proved) the right is taken off that token and the
 * next qualifying token is tried. Nothing here returns a token to a caller
 * beyond the call it was opened for.
 */
import type { Db } from '../../db/connection.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { firstSequential } from '../../lib/sequential.ts'
import { TunnelProviderError } from './errors.ts'
import {
  type BadgeMissing,
  type BadgeNeed,
  type BadgeRow,
  listBadges,
  openBadgeToken,
  pickBadges,
  recordBadgeFailure,
} from './records.ts'

/** No active API Token on the account qualifies. `missing` says whether none has the right or none has the zone. */
export class BadgeUnavailable extends Error {
  readonly need: BadgeNeed
  readonly missing: Exclude<BadgeMissing, null>
  constructor(need: BadgeNeed, missing: Exclude<BadgeMissing, null>) {
    super(`no API token for ${need.capability}`)
    this.name = 'BadgeUnavailable'
    this.need = need
    this.missing = missing
  }
}

/** Every qualifying token was refused by the provider for this call. */
export class BadgeRefused extends Error {
  readonly need: BadgeNeed
  constructor(need: BadgeNeed) {
    super(`the provider refused every API token for ${need.capability}`)
    this.name = 'BadgeRefused'
    this.need = need
  }
}

export type BadgeUse<T> = { value: T; badge: BadgeRow; token: string }

/** The zone named in a need, for messages. */
export function needZoneName(need: BadgeNeed): string | null {
  return 'zone' in need ? (need.zone.name ?? need.zone.id) : null
}

function refusedPermission(err: unknown): 'whole' | 'right' | null {
  if (!(err instanceof TunnelProviderError)) return null
  if (err.code === 'unauthorized') return 'whole'
  return err.code === 'forbidden' ? 'right' : null
}

/** Do the call with each qualifying token in turn until one is accepted. */
export async function useBadges<T>(
  db: Db,
  secrets: DerivedSecretsConfig,
  carrierId: string,
  need: BadgeNeed,
  run: (token: string, badge: BadgeRow) => Promise<T>
): Promise<BadgeUse<T>> {
  const picked = pickBadges(await listBadges(db, carrierId), need)
  if (picked.missing) throw new BadgeUnavailable(need, picked.missing)
  let refused = false
  const used = await firstSequential(
    picked.badges,
    async (row): Promise<BadgeUse<T> | undefined> => {
      const token = await openBadgeToken(db, secrets, row)
      if (token === null) return undefined
      try {
        return { value: await run(token, row), badge: row, token }
      } catch (err) {
        const kind = refusedPermission(err)
        if (!kind) throw err
        refused = true
        await recordBadgeFailure(db, row, {
          capability: need.capability,
          zone: 'zone' in need ? { id: need.zone.id, name: need.zone.name ?? need.zone.id } : null,
          whole: kind === 'whole',
        })
        return undefined
      }
    }
  )
  if (used) return used
  if (refused) throw new BadgeRefused(need)
  throw new BadgeUnavailable(need, 'capability')
}

/** Open the best qualifying token without making a call (a check that one exists, or a first read). */
export async function openBestBadge(
  db: Db,
  secrets: DerivedSecretsConfig,
  carrierId: string,
  need: BadgeNeed
): Promise<{ badge: BadgeRow; token: string } | null> {
  const picked = pickBadges(await listBadges(db, carrierId), need)
  const opened = await firstSequential(picked.badges, async (row) => {
    const token = await openBadgeToken(db, secrets, row)
    return token === null ? undefined : { badge: row, token }
  })
  return opened ?? null
}
