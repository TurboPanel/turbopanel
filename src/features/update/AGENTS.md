# Update Manifests (`src/features/update/`)

- `src/features/update/manifest.ts` — Workers-safe channel manifest resolver
  (`fetch`-only, one fetch straight to the channel's built-in location from
  `src/contracts/update-channel.ts` — canary/rc/release on the daemon's GitHub
  Releases, `trunk` and `edge` have none; per-channel cache; returns `null` on
  any failure).
  The instance follows `TURBOPANEL_UPDATE_CHANNEL` (default `release`; invalid
  is a Deno startup error) and every queued daemon update carries that channel
