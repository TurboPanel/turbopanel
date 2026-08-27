#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-net --allow-env
/**
 * Generate or check THIRD_PARTY_NOTICES.md from pnpm-lock.yaml and deno.lock.
 *
 * Usage:
 *   deno task notices:generate
 *   deno task notices:check
 */
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  defaultLicenseForPackageName,
  type DenoLockfile,
  enrichMissingPackageLicenses,
  evaluateLicensePolicy,
  fillMissingLicenses,
  fingerprintCommentValue,
  formatPolicyFailures,
  isDenoDevelopmentPackageName,
  mergeNoticePackages,
  nameFromJsrNpmSpec,
  type NoticePackage,
  noticePackageKey,
  NOTICES_FILE_NAME,
  noticesAreCurrent,
  packagesFromDenoLock,
  type DenoLockNoticeOptions,
  packagesFromPnpmLicenses,
  type PnpmLicenseEntry,
  pnpmLicenseKeys,
  pnpmPackagePaths,
  renderThirdPartyNotices,
} from "../src/lib/notices.ts";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** Shipped control-plane runtimes (Deno compile + Workers deploy). */
export const PRODUCTION_ENTRYPOINTS = [
  "src/deno.ts",
  "src/workers.ts",
] as const;

export type LicenseLookup = (pkg: NoticePackage) => Promise<string>;

export async function runGenerateNotices(options: {
  root?: string;
  argv?: string[];
  io?: {
    log?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  exit?: (code: number) => void;
  lookupLicense?: LicenseLookup;
  loadPnpmLicenses?: (
    prodOnly: boolean,
  ) => Promise<Record<string, PnpmLicenseEntry[]>>;
  denoProductionRoots?: readonly string[];
  resolveDenoInfoSpecifiers?: (
    entrypoints: readonly string[],
  ) => Promise<string[]>;
} = {}): Promise<0 | 1> {
  const root = options.root ?? ROOT;
  const argv = options.argv ?? Deno.args;
  const io = options.io ?? console;
  const leave = options.exit ?? ((code: number) => Deno.exit(code));
  const check = argv.includes("--check");
  const lookup = options.lookupLicense ?? lookupRegistryLicense;
  const loadPnpm = options.loadPnpmLicenses ??
    ((prodOnly: boolean) => loadPnpmLicenses(root, prodOnly));

  const allGrouped = await loadPnpm(false);
  const prodGrouped = await loadPnpm(true);
  const pnpmPackages = await fillMissingLicenses(
    enrichMissingPackageLicenses(
      packagesFromPnpmLicenses(allGrouped, pnpmLicenseKeys(prodGrouped)),
      (pkg) => readPnpmInstallLicense(root, allGrouped, pkg),
    ),
    async (pkg) => {
      if (pkg.source?.startsWith("deno.lock")) {
        return lookupRegistryLicense(pkg);
      }
      return fetchNpmLicense(pkg.name, pkg.version);
    },
  );

  const denoLock = JSON.parse(
    await Deno.readTextFile(join(root, "deno.lock")),
  ) as DenoLockfile;
  const productionRoots = options.denoProductionRoots ??
    await (options.resolveDenoInfoSpecifiers ??
      ((entrypoints) => specifiersFromDenoInfo(root, entrypoints)))(
      PRODUCTION_ENTRYPOINTS,
    );
  const denoGraph: DenoLockNoticeOptions = {
    productionRoots: productionRoots.length > 0
      ? productionRoots
      : workspaceProductionRoots(denoLock),
  };
  const denoPackages = await fillMissingLicenses(
    packagesFromDenoLock(denoLock, {}, denoGraph),
    lookup,
  );
  const pnpmKeys = new Set(pnpmPackages.map((pkg) => noticePackageKey(pkg)));
  const denoOnly = denoPackages.filter((pkg) =>
    !pnpmKeys.has(noticePackageKey(pkg))
  );
  const packages = mergeNoticePackages([pnpmPackages, denoOnly]);
  const policy = evaluateLicensePolicy(packages, {
    repoLicense: "AGPL-3.0-only",
  });
  if (policy.length > 0) {
    io.error?.("generate-notices: unreviewed license class:\n");
    io.error?.(formatPolicyFailures(policy));
    leave(1);
    return 1;
  }

  const markdown = renderThirdPartyNotices(packages, {
    repoLicense: "AGPL-3.0-only",
    productName: "TurboPanel Control Plane",
    regenerateCommand: "deno task notices:generate",
    lockfileFingerprints: {
      "pnpm-lock.yaml": fingerprintCommentValue(
        await hashFile(join(root, "pnpm-lock.yaml")),
      ),
      "deno.lock": fingerprintCommentValue(
        await hashFile(join(root, "deno.lock")),
      ),
    },
  });

  const noticesPath = join(root, NOTICES_FILE_NAME);
  if (check) {
    let existing: string;
    try {
      existing = await Deno.readTextFile(noticesPath);
    } catch {
      io.error?.(
        `generate-notices: missing ${NOTICES_FILE_NAME} — run deno task notices:generate`,
      );
      leave(1);
      return 1;
    }
    if (!noticesAreCurrent(existing, markdown)) {
      io.error?.(
        `generate-notices: ${NOTICES_FILE_NAME} is stale relative to the lockfile. Run deno task notices:generate and commit the result.`,
      );
      leave(1);
      return 1;
    }
    io.log?.(`generate-notices: ${NOTICES_FILE_NAME} is current.`);
    return 0;
  }

  await Deno.writeTextFile(noticesPath, markdown);
  io.log?.(
    `generate-notices: wrote ${NOTICES_FILE_NAME} (${packages.length} packages).`,
  );
  return 0;
}

export function workspaceProductionRoots(lock: DenoLockfile): string[] {
  return [...(lock.workspace?.dependencies ?? [])].filter((spec) => {
    const name = nameFromJsrNpmSpec(spec);
    return name.length > 0 && !isDenoDevelopmentPackageName(name);
  });
}

export async function specifiersFromDenoInfo(
  root: string,
  entrypoints: readonly string[],
  runCommand?: (
    args: string[],
  ) => Promise<{ success: boolean; stdout: string }>,
): Promise<string[]> {
  const run = runCommand ?? (async (args) => {
    const result = await new Deno.Command(Deno.execPath(), {
      args,
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      success: result.success,
      stdout: new TextDecoder().decode(result.stdout),
    };
  });
  const specs = new Set<string>();
  for (const entry of entrypoints) {
    const result = await run(["info", "--json", "--quiet", entry]);
    if (!result.success) continue;
    collectSpecifiersFromDenoInfoJson(result.stdout, specs);
  }
  return [...specs].sort((a, b) => a.localeCompare(b));
}

export function collectSpecifiersFromDenoInfoJson(
  json: string,
  into = new Set<string>(),
): Set<string> {
  try {
    const parsed = JSON.parse(json) as {
      modules?: Array<{
        dependencies?: Array<{ specifier?: string }>;
        specifier?: string;
      }>;
      npmPackages?: Record<string, unknown>;
    };
    for (const mod of parsed.modules ?? []) {
      if (isRemoteDenoSpec(mod.specifier)) into.add(mod.specifier ?? "");
      for (const dep of mod.dependencies ?? []) {
        if (isRemoteDenoSpec(dep.specifier)) into.add(dep.specifier ?? "");
      }
    }
    for (const name of Object.keys(parsed.npmPackages ?? {})) {
      into.add(name.includes(":") ? name : `npm:${name}`);
    }
  } catch {
    // ignore malformed deno info JSON
  }
  return into;
}

function isRemoteDenoSpec(spec: string | undefined): spec is string {
  return Boolean(spec?.startsWith("jsr:") || spec?.startsWith("npm:"));
}

export async function loadPnpmLicenses(
  root: string,
  prodOnly: boolean,
): Promise<Record<string, PnpmLicenseEntry[]>> {
  const args = ["licenses", "list", "--json", "--long"];
  if (prodOnly) args.push("--prod");
  const result = await new Deno.Command("pnpm", {
    args,
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (!result.success) {
    throw new Error(
      `generate-notices: pnpm licenses list failed (${result.code}): ${
        stderr || stdout || "no output"
      }`,
    );
  }
  const start = stdout.indexOf("{");
  if (start === -1) {
    throw new TypeError("generate-notices: no JSON in pnpm licenses output");
  }
  const parsed = JSON.parse(stdout.slice(start));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("generate-notices: unexpected pnpm licenses JSON");
  }
  return parsed as Record<string, PnpmLicenseEntry[]>;
}

export async function lookupRegistryLicense(
  pkg: NoticePackage,
): Promise<string> {
  if (pkg.source !== "deno.lock (npm)" && pkg.source !== "deno.lock (jsr)") {
    return "";
  }
  if (pkg.source === "deno.lock (npm)") {
    return await fetchNpmLicense(pkg.name, pkg.version);
  }
  const fromRegistry = await fetchLicenseField(
    `https://jsr.io/${pkg.name}/${pkg.version}/deno.json`,
  );
  if (fromRegistry) return fromRegistry;
  const fromLicense = await fetchJsrLicenseText(pkg.name, pkg.version);
  if (fromLicense) return fromLicense;
  return defaultLicenseForPackageName(pkg.name) || "";
}

async function fetchJsrLicenseText(
  name: string,
  version: string,
): Promise<string> {
  try {
    const response = await fetch(`https://jsr.io/${name}/${version}/LICENSE`);
    if (!response.ok) return "";
    const text = await response.text();
    if (/Permission is hereby granted, free of charge/i.test(text)) {
      return "MIT";
    }
    if (/Apache License[\s\S]{0,80}Version 2\.0/i.test(text)) {
      return "Apache-2.0";
    }
    if (/ISC License/i.test(text)) return "ISC";
    return "";
  } catch {
    return "";
  }
}

export function readPnpmInstallLicense(
  root: string,
  grouped: Record<string, PnpmLicenseEntry[]>,
  pkg: NoticePackage,
): string | undefined {
  const rel = pnpmPackagePaths(grouped).get(noticePackageKey(pkg));
  if (!rel) return undefined;
  const dir = rel.startsWith("/") ? rel : join(root, rel);
  const pkgJsonPath = join(dir, "package.json");
  try {
    const parsed = JSON.parse(Deno.readTextFileSync(pkgJsonPath)) as {
      license?: unknown;
      licenses?: Array<{ type?: string }>;
    };
    const field = parsed.license ?? parsed.licenses?.[0]?.type;
    if (typeof field === "string" && field.trim()) return field.trim();
  } catch {
    // fall through
  }
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
    const candidate = join(dir, name);
    try {
      const text = Deno.readTextFileSync(candidate);
      if (/Permission is hereby granted, free of charge/i.test(text)) {
        return "MIT";
      }
      if (/ISC License/i.test(text)) return "ISC";
      if (/Apache License[\s\S]{0,80}Version 2\.0/i.test(text)) {
        return "Apache-2.0";
      }
    } catch {
      // try next
    }
  }
  return undefined;
}

async function fetchNpmLicense(name: string, version: string): Promise<string> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${
    encodeURIComponent(version)
  }`;
  const fromRegistry = await fetchLicenseField(url);
  return fromRegistry || defaultLicenseForPackageName(name) || "";
}

async function fetchLicenseField(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) return "";
    const parsed = await response.json() as { license?: unknown };
    return typeof parsed.license === "string" ? parsed.license : "";
  } catch {
    return "";
  }
}

async function hashFile(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return encodeHex(new Uint8Array(digest));
}

if (import.meta.main) {
  await runGenerateNotices();
}
