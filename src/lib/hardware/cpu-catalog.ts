/**
 * Hand-curated CPU thermal/power catalog — resolves a detected `cpuModel`
 * string (e.g. `server.metadata.hardwareProfile.cpuModel`) to representative
 * TDP / Tjmax figures for headroom display when the operator has not set an
 * explicit override.
 *
 * Best-effort: real silicon varies by SKU/stepping/OEM configuration, so
 * these are reference values, not measured-per-unit facts. An exact-model
 * miss falls back to a family regex; a total miss resolves to `null` and the
 * caller shows no headroom rather than a fabricated number.
 */

export type CpuCatalogEntry = {
  tdpWatts: number;
  tjMaxCelsius: number;
};

/**
 * Lower-case, whitespace-collapsed, and stripped of the adornments real
 * `/proc/cpuinfo` `model name` strings carry that a hand-curated catalog key
 * never does: trademark markers (`(R)`/`(TM)`/`(C)`/`®`/`™`/`©`), a trailing
 * advertised-clock suffix (`CPU @ 3.00GHz`), and a trailing core-count
 * suffix (`8-Core Processor`). Used for both lookup and storage keys.
 */
export function normalizeCpuModel(cpuModel: string): string {
  return cpuModel
    .trim()
    .toLowerCase()
    .replace(/[®™©]/g, "")
    .replace(/\((?:r|tm|c)\)/g, "")
    .replace(/\bcpu\b/g, "")
    .replace(/@\s*[\d.]+\s*[mg]hz\b/g, "")
    .replace(/\b\d+-core processor\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Exact-match table, keyed by {@link normalizeCpuModel}. Representative
 * entries per family — Xeon E5/E7 v3-v4, Xeon Scalable, EPYC, Ryzen /
 * Threadripper, Core i-series, Ampere Altra, AWS Graviton.
 */
const CPU_CATALOG: Record<string, CpuCatalogEntry> = {
  // Intel Xeon E5 v3/v4
  "intel xeon e5-2620 v4": { tdpWatts: 85, tjMaxCelsius: 92 },
  "intel xeon e5-2630 v4": { tdpWatts: 85, tjMaxCelsius: 92 },
  "intel xeon e5-2650 v4": { tdpWatts: 105, tjMaxCelsius: 92 },
  "intel xeon e5-2680 v4": { tdpWatts: 120, tjMaxCelsius: 92 },
  "intel xeon e5-2690 v3": { tdpWatts: 135, tjMaxCelsius: 92 },
  // Intel Xeon E7 v4
  "intel xeon e7-8880 v4": { tdpWatts: 150, tjMaxCelsius: 92 },
  // Intel Xeon Scalable (Skylake/Cascade Lake/Ice Lake generations)
  "intel xeon gold 6130": { tdpWatts: 125, tjMaxCelsius: 100 },
  "intel xeon gold 6230": { tdpWatts: 125, tjMaxCelsius: 100 },
  "intel xeon gold 6248r": { tdpWatts: 205, tjMaxCelsius: 100 },
  "intel xeon gold 6338": { tdpWatts: 205, tjMaxCelsius: 105 },
  "intel xeon platinum 8280": { tdpWatts: 205, tjMaxCelsius: 100 },
  "intel xeon platinum 8380": { tdpWatts: 270, tjMaxCelsius: 105 },
  "intel xeon silver 4210": { tdpWatts: 85, tjMaxCelsius: 100 },
  "intel xeon silver 4310": { tdpWatts: 120, tjMaxCelsius: 105 },
  "intel xeon bronze 3204": { tdpWatts: 85, tjMaxCelsius: 100 },
  // AMD EPYC (Naples / Rome / Milan / Genoa)
  "amd epyc 7302": { tdpWatts: 155, tjMaxCelsius: 95 },
  "amd epyc 7402": { tdpWatts: 180, tjMaxCelsius: 95 },
  "amd epyc 7502": { tdpWatts: 180, tjMaxCelsius: 95 },
  "amd epyc 7543": { tdpWatts: 225, tjMaxCelsius: 95 },
  "amd epyc 7763": { tdpWatts: 280, tjMaxCelsius: 95 },
  "amd epyc 9354": { tdpWatts: 280, tjMaxCelsius: 95 },
  "amd epyc 9654": { tdpWatts: 360, tjMaxCelsius: 95 },
  // AMD Ryzen (desktop) / Threadripper (HEDT/workstation)
  "amd ryzen 5 5600x": { tdpWatts: 65, tjMaxCelsius: 95 },
  "amd ryzen 7 5800x": { tdpWatts: 105, tjMaxCelsius: 90 },
  "amd ryzen 9 5950x": { tdpWatts: 105, tjMaxCelsius: 90 },
  "amd ryzen 9 7950x": { tdpWatts: 170, tjMaxCelsius: 95 },
  "amd ryzen threadripper 3960x": { tdpWatts: 280, tjMaxCelsius: 95 },
  "amd ryzen threadripper pro 5975wx": { tdpWatts: 280, tjMaxCelsius: 95 },
  // Intel Core i-series (desktop)
  "intel core i5-12400": { tdpWatts: 65, tjMaxCelsius: 100 },
  "intel core i7-12700k": { tdpWatts: 125, tjMaxCelsius: 100 },
  "intel core i9-13900k": { tdpWatts: 125, tjMaxCelsius: 100 },
  // Ampere Altra (Arm server)
  "ampere altra q80-30": { tdpWatts: 250, tjMaxCelsius: 85 },
  "ampere altra max m128-30": { tdpWatts: 250, tjMaxCelsius: 85 },
  // AWS Graviton (Arm server, cloud-only — TDP/Tjmax are Annapurna-published estimates)
  "aws graviton2": { tdpWatts: 110, tjMaxCelsius: 95 },
  "aws graviton3": { tdpWatts: 130, tjMaxCelsius: 95 },
};

/**
 * Family regex fallbacks, checked in order, for models not in the exact
 * table. Deliberately conservative — broad enough to catch an unlisted SKU
 * in a known family, generic enough to never falsely match another vendor.
 */
const CPU_FAMILY_FALLBACKS: readonly { pattern: RegExp; entry: CpuCatalogEntry }[] = [
  // Intel Xeon E5/E7 v3/v4
  { pattern: /\bxeon e[57]-\d{4} v[34]\b/, entry: { tdpWatts: 120, tjMaxCelsius: 92 } },
  // Intel Xeon Scalable (Bronze/Silver/Gold/Platinum, any generation)
  { pattern: /\bxeon (bronze|silver|gold|platinum) \d{4,5}/, entry: { tdpWatts: 150, tjMaxCelsius: 100 } },
  // AMD EPYC, any generation
  { pattern: /\bepyc \d{4}/, entry: { tdpWatts: 200, tjMaxCelsius: 95 } },
  // AMD Ryzen Threadripper (incl. PRO)
  { pattern: /\bthreadripper( pro)? \d{4}[a-z]*/, entry: { tdpWatts: 250, tjMaxCelsius: 95 } },
  // AMD Ryzen (desktop, non-Threadripper)
  { pattern: /\bryzen [3579] \d{4}[a-z]*/, entry: { tdpWatts: 95, tjMaxCelsius: 95 } },
  // Intel Core i-series (desktop)
  { pattern: /\bcore i[3579]-\d{4,5}[a-z]*/, entry: { tdpWatts: 95, tjMaxCelsius: 100 } },
  // Ampere Altra, any SKU
  { pattern: /\baltra( max)? [a-z]\d+-\d+/, entry: { tdpWatts: 250, tjMaxCelsius: 85 } },
  // AWS Graviton, any generation
  { pattern: /\bgraviton\d?\b/, entry: { tdpWatts: 120, tjMaxCelsius: 95 } },
];

/**
 * Resolve TDP / Tjmax for a detected CPU model. Exact match first (after
 * normalization), then the first matching family regex, else `null` — never
 * a fabricated guess for a wholly unrecognized string.
 */
export function resolveCpuCatalogEntry(
  cpuModel: string | null | undefined,
): CpuCatalogEntry | null {
  if (!cpuModel) return null;
  const normalized = normalizeCpuModel(cpuModel);
  if (normalized.length === 0) return null;

  const exact = CPU_CATALOG[normalized];
  if (exact) return exact;

  for (const { pattern, entry } of CPU_FAMILY_FALLBACKS) {
    if (pattern.test(normalized)) return entry;
  }

  return null;
}

/**
 * True when `cpuModel` resolves via the exact-model table rather than a
 * family regex fallback. Lets a caller (e.g. `resolveEffectiveCpuThermalLimits`
 * in `server-metadata.ts`) report `'catalog-exact'` vs `'catalog-family'`
 * without duplicating the lookup logic.
 */
export function isExactCpuCatalogMatch(
  cpuModel: string | null | undefined,
): boolean {
  if (!cpuModel) return false;
  const normalized = normalizeCpuModel(cpuModel);
  if (normalized.length === 0) return false;
  return normalized in CPU_CATALOG;
}
