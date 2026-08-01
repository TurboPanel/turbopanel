# TurboPanel Instance

Control plane for TurboPanel — Hono API on Cloudflare Workers and Deno (self-hosted), with Caddy as the TLS entrypoint.

GitHub: [turbopanel/instance](https://github.com/turbopanel/instance). Local checkout: `~/instance` (or `${TURBOPANEL_INSTANCE_REPO}`).

## Development

Do **not** bootstrap this repo on its own. The co-located stack is owned by **[turbopanel/dev](https://github.com/turbopanel/dev)**.

```sh
curl -fsSL dev.turbopanel.sh | sh
```

That installs/updates `~/dev`, launches the developer console, and (after **Converge**) brings up the instance (`turbopanel-instance.service` on the Unix socket), Caddy (`https://localhost:8443` / `http://localhost:8880`), and supporting Docker services. The instance never installs itself — the daemon owns orchestration.

Typical layout after converge:

| Path | Repo |
| --- | --- |
| `~/dev` | [turbopanel/dev](https://github.com/turbopanel/dev) — console + Ansible overlay |
| `~/daemon` | daemon |
| `~/instance` | this repo |
| `~/ui` | product console |
| `~/website` | marketing + docs |

Edit sources in place under `$HOME`. Re-converge from the console when the stack needs refresh. Details: [dev README](https://github.com/turbopanel/dev#readme) and [Local development](https://turbopanel.io/docs/getting-started/development).

Agent conventions and subsystem map: [AGENTS.md](./AGENTS.md).
