# Licensing and Project Metadata

- **License:** AGPL-3.0-only ([`LICENSE`](../LICENSE), `package.json` /
  `deno.json`). Trademarks are not granted by the software license
  ([`TRADEMARKS.md`](../TRADEMARKS.md)). Third-party components keep their own
  licenses ([`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md));
  `pnpm notices:generate` / `notices:check` enumerate the pnpm graph **and** the
  Deno `jsr` + `npm` graphs in `deno.lock` (Deno-only npm entries are merged in;
  peer-suffixed lock ids are parsed as `name@version`). `GET /api/health`
  reports `{ license, revision: { commit, sourceUrl } }` so a network user can
  identify Corresponding Source for the **exact** revision (not `trunk`).
  `createApp()` injects `platformEnv` / `getPlatformEnv` **before** the health
  route; the Deno entry point passes `getPlatformEnv: () => Deno.env.toObject()`
  so systemd `TURBOPANEL_REVISION` is never observed as `unknown`. Published
  story: `../website` `/open-source` and `docs/getting-started/licensing.mdx`.
  Contributions require the
  [CLA](https://github.com/TurboPanel/.github/blob/trunk/CLA.md).
