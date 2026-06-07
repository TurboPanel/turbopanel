/**
 * Dev-mode detection for the Deno instance.
 *
 * The developer surface (fleet/diagnostics/shell/dev-sync/tunnel under
 * `/api/developer/v1` + `/ws/developer/v1`) exists only to help a developer
 * babysit a development instance and its development nodes. It must never be
 * exposed by a production deployment.
 *
 * We key off `TURBOPANEL_UI_MODE`, the existing dev/prod toggle plumbed through
 * the `instance-launch` Ansible role and Caddy: `dev` proxies to the Expo dev
 * server, `static` serves the exported production UI. Anything other than the
 * explicit `static` value is treated as dev (so a bare `deno task` run, with the
 * var unset, still gets the developer surface).
 *
 * Production prebuilt instance hosting is out of scope today (seams only); when
 * it lands it must launch with `TURBOPANEL_UI_MODE=static` so this returns false.
 */
export function isDeveloperSurfaceEnabled(): boolean {
  const mode = Deno.env.get('TURBOPANEL_UI_MODE')?.trim().toLowerCase()
  return mode !== 'static'
}
