# Update Manifests (`src/features/update/`)

- `src/features/update/manifest.ts` — Workers-safe channel manifest resolver
  (`fetch`-only, one fetch straight to the channel's built-in location from
  `src/contracts/update-channel.ts` — canary/rc/release on the daemon's GitHub
  Releases, `trunk` and `edge` have none; per-channel cache; returns `null` on
  any failure).
  The instance follows `TURBOPANEL_UPDATE_CHANNEL` (default `release`; invalid
  is a Deno startup error) and every queued daemon update carries that channel
- `setUpdateManifestProvider` is the one development seam: `src/deno-dev.ts`
  installs the dev overlay (`src/developer/dev-update-overlay.ts`), which
  answers the built overlay identity for the daemon (or null when nothing was
  built) and null for the control plane and the web interface. There is no
  other hook here; a development install rebuilds and pushes the daemon only
  through Admin > Updates Build and Push Daemon.
