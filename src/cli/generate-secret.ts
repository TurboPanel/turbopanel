/**
 * `turbopanel generate-secret` — one TURBOPANEL_SECRET-shaped value
 * on stdout, without a source checkout (instance-runtime-packaging, Road to
 * 0.1.x). The generator is scripts/generate-secret.mjs, re-exported by
 * src/generate-secret.ts — the same bytes the instance-launch role gets from
 * `node scripts/generate-secret.mjs` in a checkout.
 */
import { generateSecret } from "../generate-secret.ts";

export function runGenerateSecretCommand(
  write: (line: string) => void = (line) => console.log(line),
): void {
  write(generateSecret());
}
