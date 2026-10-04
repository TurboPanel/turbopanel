/**
 * Guards for suites that need a backing service (Postgres, Redis).
 *
 * Locally a missing service skips the suite with a warning. CI sets
 * `TURBOPANEL_REQUIRE_DB=1` (Postgres shards) or `TURBOPANEL_REQUIRE_REDIS=1`
 * (the Redis job) so the same gap throws instead: a suite that returns early
 * reports PASS without asserting anything, which hides a broken CI job.
 */

function flagSet(name: string): boolean {
  return Deno.env.get(name) === '1'
}

/** True when a missing database must fail the run instead of skipping. */
export function databaseRequired(): boolean {
  return flagSet('TURBOPANEL_REQUIRE_DB')
}

/** True when a missing Redis socket must fail the run instead of skipping. */
export function redisRequired(): boolean {
  return flagSet('TURBOPANEL_REQUIRE_REDIS')
}

/**
 * Call where a suite would print "Skipping ...: TURBOPANEL_DATABASE_URL not
 * set" and return. Throws when the database is required; otherwise warns.
 */
export function skipWithoutDatabase(label: string): void {
  const message = `Skipping ${label}: TURBOPANEL_DATABASE_URL not set`
  if (databaseRequired()) {
    throw new Error(`${message} -- TURBOPANEL_REQUIRE_DB=1, so a missing database fails the suite`)
  }
  console.warn(message)
}

/** Redis twin of {@link skipWithoutDatabase}, for an absent Redis socket. */
export function skipWithoutRedis(label: string, socket: string): void {
  const message = `Skipping ${label}: Redis socket not found at ${socket}`
  if (redisRequired()) {
    throw new Error(`${message} -- TURBOPANEL_REQUIRE_REDIS=1, so a missing Redis fails the suite`)
  }
  console.warn(message)
}
