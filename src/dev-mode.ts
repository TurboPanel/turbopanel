/**
 * Dev-mode detection for the Deno instance.
 *
 * The developer surface (fleet/diagnostics/shell/dev-sync/tunnel under
 * `/api/developer/v1` + `/ws/developer/v1`) exists only to help a developer
 * babysit a development instance and its development nodes. It must never be
 * exposed by a production deployment.
 *
 * The surface is gated behind a **single explicit** flag — it never fails
 * open: `TURBOPANEL_DEV_SURFACE=1`. The daemon's
 * `turbopanel-instance.service.j2` is the only managed writer of that flag,
 * and it emits it solely for co-located Deno source-mode dev.
 *
 * `TURBOPANEL_UI_MODE` is **not** consulted: it selects how Caddy serves the
 * UI (Expo proxy vs. static export) and is scoped to Caddy/Expo/static UI
 * selection only. `TURBOPANEL_MODE=development` alone is likewise not enough.
 * Anything other than the literal `1` — unset, `true`, `yes`, mistyped — is
 * treated as disabled.
 */
export function isExplicitDevelopmentMode(): boolean {
  if (typeof Deno === 'undefined') return false
  return Deno.env.get('TURBOPANEL_DEV_SURFACE')?.trim() === '1'
}

export function isDeveloperSurfaceEnabled(): boolean {
  return isExplicitDevelopmentMode()
}
