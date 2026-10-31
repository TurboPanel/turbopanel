/**
 * What a DNS host must be able to do for a DNS-01 challenge: publish one TXT
 * record and take it away again. Several records may share one name (a
 * wildcard and its apex are answered at the same `_acme-challenge` name), so a
 * record is addressed by its own id, never by its name.
 */
export type ChallengeRecordInput = {
  zoneId: string
  /** The full record name, `_acme-challenge.example.com`. */
  name: string
  value: string
}

export type ChallengeRecordRef = { zoneId: string; recordId: string }

export type DnsChallengeProvider = {
  /**
   * Where the name is a CNAME, the name it points at (lowercase, no trailing
   * dot); otherwise null. A TXT record cannot sit beside a CNAME, so the
   * challenge is written at the target instead.
   */
  lookupCname(input: { zoneId: string; name: string }): Promise<string | null>
  /**
   * A cheap read that proves the provider still accepts the token for the
   * zone. Throws the provider's refusal (a token that was rolled or limited) so
   * an order is never started with a token that can no longer write. Optional:
   * a host without one is not checked.
   */
  checkZone?(zoneId: string): Promise<void>
  /**
   * The TXT values the provider holds at a name, read back through its own
   * API. The challenge is only answered once the record is seen here, so the
   * authority is not asked to validate a record that is not published yet.
   * Optional: a host without one is answered after the usual short pause.
   */
  txtValues?(input: { zoneId: string; name: string }): Promise<string[]>
  present(input: ChallengeRecordInput): Promise<ChallengeRecordRef>
  /** Remove a record; one that is already gone counts as removed. */
  remove(ref: ChallengeRecordRef): Promise<void>
}

/** The name a CA looks at for a name's DNS-01 challenge (a wildcard uses its base name). */
export function challengeRecordName(name: string): string {
  const base = name.startsWith('*.') ? name.slice(2) : name
  return `_acme-challenge.${base}`
}

/**
 * The challenge name is a CNAME, so the record has to go where it points, and
 * that place cannot be edited with the connected account. Nothing was changed.
 */
export class ChallengeTargetError extends Error {
  readonly name_: string
  readonly target: string
  constructor(name: string, target: string, reason: string) {
    super(reason)
    this.name = 'ChallengeTargetError'
    this.name_ = name
    this.target = target
  }
}
