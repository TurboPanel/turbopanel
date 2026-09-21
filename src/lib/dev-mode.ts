/**
 * Explicit development-mode flag (`TURBOPANEL_DEV_SURFACE=1`).
 *
 * Shared by the kernel (ephemeral secrets) and the developer surface gate.
 * The daemon's `turbopanel-instance.service.j2` is the only managed writer
 * of that flag, and it emits it solely for co-located Deno source-mode dev.
 *
 * `TURBOPANEL_UI_MODE` is not consulted: it selects how Caddy serves the UI.
 * Anything other than the literal `1` is treated as disabled.
 */
export function isExplicitDevelopmentMode(): boolean {
  if (typeof Deno === 'undefined') return false
  return Deno.env.get('TURBOPANEL_DEV_SURFACE')?.trim() === '1'
}
