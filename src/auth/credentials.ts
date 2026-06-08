import { ROOT_USER_ID } from './session-store.ts'

export const PAM_ROOT_USERNAME = 'root'

export type AuthRuntime = 'deno' | 'workers'

export type VerifyResult =
  | { ok: true; userId: string; username: string; isRoot: boolean }
  | { ok: false }

async function verifyRootViaPam(password: string): Promise<boolean> {
  try {
    // sudo does not reliably forward Deno Command stdin to pamtester; shell pipe matches
    // `printf '%s\n' "$PW" | sudo -n pamtester login root authenticate`.
    const result = await new Deno.Command('/bin/sh', {
      args: [
        '-c',
        "printf '%s\\n' \"$TP_PAM_PASSWORD\" | sudo -n /usr/bin/pamtester login root authenticate",
      ],
      env: { ...Deno.env.toObject(), TP_PAM_PASSWORD: password },
      stdout: 'null',
      stderr: 'null',
    }).output()

    return result.success
  } catch {
    return false
  }
}

export async function verifyCredentials(
  username: string,
  password: string,
  runtime: AuthRuntime,
): Promise<VerifyResult> {
  if (runtime === 'deno' && username === PAM_ROOT_USERNAME) {
    const ok = await verifyRootViaPam(password)
    if (ok) {
      return {
        ok: true,
        userId: ROOT_USER_ID,
        username: 'root',
        isRoot: true,
      }
    }
    return { ok: false }
  }

  // TODO: DB user lookup — query user table, verify hashed password
  return { ok: false }
}
