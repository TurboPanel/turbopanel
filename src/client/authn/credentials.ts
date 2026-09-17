import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { account, user } from "../../lib/db/schema.ts";
import { isExplicitDevelopmentMode } from "../../dev-mode.ts";
import { isInstanceInstalled } from "./install-state.ts";
import { verifyPassword } from "./password.ts";
import { compatLogWarn } from "../../log-compat.ts";

export const PAM_ROOT_USERNAME = "root";

const HOST_USERNAME_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Fixed Argon2id PHC string (baseline OWASP params, no real account behind
 * it) verified on the not-found branch below so "no such email" costs the
 * same wall-clock time as "wrong password" — otherwise the row lookup alone
 * returns near-instantly and a timing side channel leaks which emails have a
 * local password account. A module-scope literal, not a `hashPassword()`
 * call: the latter reaches `crypto.getRandomValues` at import time, which
 * `check:workers-bundle` rejects outside a request handler.
 */
const TIMING_SAFE_DUMMY_ARGON2ID_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$YhRmrUGYipN2DNXipawzXg$4LBWbfHCDCeMA2i1czRRpclNzQPo01h/0sfSMSOq9Yg";

export type AuthRuntime = "deno" | "workers";

/** Hyperdrive caches SELECTs; auth reads after verify must not serve stale rows. */
function bypassHyperdriveQueryCache() {
  return sql`random() >= 0`;
}

export type VerifyResult =
  | { ok: true; username: string; isRoot: true }
  | {
    ok: true;
    userId: string;
    email: string;
    isRoot: false;
    is2FaEnabled: boolean;
  }
  | { ok: false; reason?: "email_not_verified" };

/**
 * Dynamic-loader variables Deno refuses to pass to a child under a restricted
 * `--allow-run` (it throws NotCapable "spawn subprocess with LD_LIBRARY_PATH
 * environment variable"). The compiled instance unit sets LD_LIBRARY_PATH for
 * the vendored libduckdb.so, which made every spawn here fail on a managed
 * install — the wizard rejected every host credential (install-rehearsal,
 * Road to 0.1.x). The children (sudo, pamtester, sh) need none of them.
 */
const LOADER_ENV_VARS = [
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LD_AUDIT",
  "DYLD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
];

export function spawnEnvWithoutLoaderVars(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env = { ...Deno.env.toObject(), ...extra };
  for (const key of LOADER_ENV_VARS) delete env[key];
  return env;
}

async function verifyPamLogin(
  username: string,
  password: string,
): Promise<boolean> {
  if (!HOST_USERNAME_RE.test(username)) return false;

  try {
    // Pipe the password on stdin — never put it in the child environment
    // or invoke a shell pipeline.
    const child = new Deno.Command("sudo", {
      args: ["-n", "/usr/bin/pamtester", "login", username, "authenticate"],
      // Inherit the environment minus the dynamic-loader variables — never
      // inject the password into it.
      clearEnv: true,
      env: spawnEnvWithoutLoaderVars(),
      stdin: "piped",
      stdout: "null",
      stderr: "null",
    }).spawn();

    const writer = child.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(`${password}\n`));
    } finally {
      await writer.close();
    }

    const status = await child.status;
    return status.success;
  } catch (err) {
    // Never silent: on a compiled instance a spawn refusal (NotCapable,
    // EACCES on the working directory, a missing pamtester) is
    // indistinguishable from a wrong password without this line.
    compatLogWarn(
      "auth",
      `install host-credential check could not run pamtester: ${
        err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      }`,
    );
    return false;
  }
}

async function userHasInstallSudo(username: string): Promise<boolean> {
  if (!HOST_USERNAME_RE.test(username)) return false;

  try {
    const result = await new Deno.Command("/bin/sh", {
      args: [
        "-c",
        String
          .raw`groups=$(id -nG "$TP_PAM_USERNAME" 2>/dev/null) || exit 1; for g in sudo wheel admin; do echo "$groups" | tr " " "\n" | grep -qx "$g" && exit 0; done; exit 1`,
      ],
      clearEnv: true,
      env: spawnEnvWithoutLoaderVars({ TP_PAM_USERNAME: username }),
      stdout: "null",
      stderr: "null",
    }).output();

    return result.success;
  } catch (err) {
    compatLogWarn(
      "auth",
      `install host-credential check could not read group membership: ${
        err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Dev-only: bypass PAM password verification, keep group-membership check.
 *
 * Requires both `TURBOPANEL_DEV_HOST_AUTH=group-only` **and**
 * {@link isExplicitDevelopmentMode}. Production never honors the env var —
 * if it is set outside explicit development mode it is ignored with a warning.
 */
export function isDevHostAuthMode(): boolean {
  if (Deno.env.get("TURBOPANEL_DEV_HOST_AUTH") !== "group-only") return false;
  if (!isExplicitDevelopmentMode()) {
    compatLogWarn(
      "auth",
      "TURBOPANEL_DEV_HOST_AUTH=group-only is ignored outside explicit development mode",
    );
    return false;
  }
  return true;
}

/** PAM root or a sudo-capable host user — install wizard only, never issues a session. */
export async function verifyInstallHostCredentials(
  username: string,
  password: string,
  runtime: AuthRuntime,
  db?: Db,
): Promise<boolean> {
  if (runtime !== "deno") return false;
  if (db && await isInstanceInstalled(db)) return false;

  const trimmed = username.trim();
  if (!HOST_USERNAME_RE.test(trimmed) || !password) return false;

  if (isDevHostAuthMode()) {
    compatLogWarn(
      "dev",
      "TURBOPANEL_DEV_HOST_AUTH=group-only — PAM password verification is disabled; verifying group membership only",
    );
    if (trimmed === PAM_ROOT_USERNAME) return true;
    return await userHasInstallSudo(trimmed);
  }

  const pamOk = await verifyPamLogin(trimmed, password);
  if (!pamOk) return false;

  if (trimmed === PAM_ROOT_USERNAME) return true;

  return await userHasInstallSudo(trimmed);
}

async function verifyDbUserCredentials(
  db: Db,
  email: string,
  password: string,
): Promise<VerifyResult> {
  const trimmed = email.trim().toLowerCase();

  const rows = await db
    .select({
      userId: user.id,
      email: user.email,
      password: account.password,
      isDisabled: user.isDisabled,
      isEmailVerified: user.isEmailVerified,
      is2FaEnabled: user.is2FaEnabled,
    })
    .from(user)
    .innerJoin(
      account,
      and(eq(account.userId, user.id), eq(account.providerId, "credential")),
    )
    .where(
      and(
        eq(user.email, trimmed),
        bypassHyperdriveQueryCache(),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row?.password || row.isDisabled) {
    // Same Argon2id cost as a real verify below, so this branch's latency
    // does not disclose whether the email has a local password account.
    await verifyPassword(password, TIMING_SAFE_DUMMY_ARGON2ID_HASH);
    return { ok: false };
  }

  const valid = await verifyPassword(password, row.password);
  if (!valid) {
    return { ok: false };
  }

  if (!row.isEmailVerified) {
    return { ok: false, reason: "email_not_verified" };
  }

  return {
    ok: true,
    userId: row.userId,
    email: row.email,
    isRoot: false,
    is2FaEnabled: row.is2FaEnabled === true,
  };
}

export async function verifyCredentials(
  login: string,
  password: string,
  runtime: AuthRuntime,
  db?: Db,
): Promise<VerifyResult> {
  if (runtime === "deno" && login === PAM_ROOT_USERNAME) {
    if (db && await isInstanceInstalled(db)) {
      return { ok: false };
    }
    const ok = await verifyInstallHostCredentials(
      PAM_ROOT_USERNAME,
      password,
      runtime,
      db,
    );
    if (ok) {
      return {
        ok: true,
        username: PAM_ROOT_USERNAME,
        isRoot: true,
      };
    }
    return { ok: false };
  }

  if (db === undefined) {
    return { ok: false };
  }

  return await verifyDbUserCredentials(db, login, password);
}
