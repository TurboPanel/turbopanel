/**
 * `turbopanel-instance generate-self-signed-cert` — the platform CA and the
 * self-signed server leaf, without a source checkout
 * (instance-runtime-packaging, Road to 0.1.x).
 *
 * Runs scripts/generate-self-signed-cert.mjs — the same script the
 * instance-certs role invokes through node from a checkout — inside the
 * compiled binary. The script reads its paths from the environment
 * (TURBOPANEL_STATE_DIR, TURBOPANEL_TLS_CA*, TURBOPANEL_TLS_CERTS_DIR) and
 * shells out to /usr/bin/openssl and /usr/bin/hostname, which is why the
 * compile task's --allow-run names both. One default differs from the
 * checkout: with no TURBOPANEL_TLS_CERTS_DIR the script would put the leaf
 * beside a repo root the binary does not have, so the subcommand points it at
 * `<state dir>/tls/certs` — inside the binary's --allow-write tree — instead.
 */

export const DEFAULT_STATE_DIR = "/var/lib/turbopanel";

function stripTrailingSlashes(value: string): string {
  let next = value;
  while (next.endsWith("/")) next = next.slice(0, -1);
  return next;
}

/** Where the leaf goes when the operator names nowhere: `<state>/tls/certs`. */
export function defaultLeafCertsDir(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const state = env.TURBOPANEL_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
  return `${stripTrailingSlashes(state)}/tls/certs`;
}

export async function runGenerateSelfSignedCertCommand(): Promise<void> {
  if (!Deno.env.get("TURBOPANEL_TLS_CERTS_DIR")?.trim()) {
    Deno.env.set(
      "TURBOPANEL_TLS_CERTS_DIR",
      defaultLeafCertsDir(Deno.env.toObject()),
    );
  }
  // The script runs at import and exits non-zero itself on failure.
  await import("../../scripts/generate-self-signed-cert.mjs");
}
