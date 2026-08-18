/**
 * Workers vitest `env` is `Cloudflare.Env` (not the retired `ProvidedEnv`).
 * {@link CloudflareBindings} is the hand-authored SoT in worker-configuration.d.ts.
 */
declare namespace Cloudflare {
  interface Env extends CloudflareBindings {}
}

interface Env extends CloudflareBindings {}
