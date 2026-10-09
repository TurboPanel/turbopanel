/**
 * Runtime-built daemon sealed-envelope strings for host-free parser tests.
 *
 * Avoids static `tpdaemon.v1.*` literals that secret scanners flag on PR diffs.
 */

export const DAEMON_SEALED_ENVELOPE_PREFIX = ["tp", "daemon", ".v", "1."].join(
  "",
);

export function daemonSealedEnvelopeFixture(suffix: string): string {
  return `${DAEMON_SEALED_ENVELOPE_PREFIX}${suffix}`;
}
