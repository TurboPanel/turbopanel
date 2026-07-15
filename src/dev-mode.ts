/**
 * Dev-mode detection for the Deno instance.
 *
 * The developer surface (fleet/diagnostics/shell/dev-sync/tunnel under
 * `/api/developer/v1` + `/ws/developer/v1`) exists only to help a developer
 * babysit a development instance and its development nodes. It must never be
 * exposed by a production deployment.
 *
 * The surface is gated behind an **explicit** development flag — it never
 * fails open. Two accepted signals:
 *
 * 1. `TURBOPANEL_DEV_SURFACE=1` — a dedicated opt-in, or
 * 2. the strict pair `TURBOPANEL_MODE=development` **and**
 *    `TURBOPANEL_UI_MODE=dev`.
 *
 * Anything else — unset, unknown, mistyped, or production values (e.g.
 * `TURBOPANEL_UI_MODE=static`) — is treated as disabled. Older behavior keyed
 * only off `TURBOPANEL_UI_MODE !== 'static'`, which failed open whenever the
 * var was unset or mistyped; that inference has been removed.
 */
export function isExplicitDevelopmentMode(): boolean {
  if (typeof Deno === 'undefined') return false
  const devSurface = Deno.env.get('TURBOPANEL_DEV_SURFACE')?.trim()
  if (devSurface === '1') return true
  const mode = Deno.env.get('TURBOPANEL_MODE')?.trim().toLowerCase()
  const uiMode = Deno.env.get('TURBOPANEL_UI_MODE')?.trim().toLowerCase()
  return mode === 'development' && uiMode === 'dev'
}

export function isDeveloperSurfaceEnabled(): boolean {
  return isExplicitDevelopmentMode()
}
