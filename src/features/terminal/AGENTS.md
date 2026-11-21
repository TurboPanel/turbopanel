# Terminal (container shells)

Pure pieces live here (`policy.ts`, `ticket.ts`, `upgrade.ts`); the routes and the open/list/kill orchestration live in `src/client/terminal/` (`routes.ts`, `sessions.ts`), because features may not import a surface. Frame rules: `src/contracts/shell-relay.ts`.

Browser terminal into a service container (feature `terminal-container-v1`). The control plane authorizes, mints the session key, and relays opaque frames; it never reads a frame and stores no key. Host terminals are a later phase.

- **Gate order** (`policy.ts`, one pure function): server switch `options.terminal.container` (403 `terminal_disabled`, always wins), then the `terminal:container` permission (403 `forbidden`), then container ownership (404 `container_not_found`: a `service` container on this server in the caller's organization), then running (409 `container_not_running`), then the daemon feature (409 `daemon_feature_missing`). No step-up for container terminals.
- **Open** (`src/client/terminal/sessions.ts`): seal the 32-byte key to the daemon (HPKE, `aad` = server id, `info` = `turbopanel shell key v1` + lower-case sid), write the `server.terminal.open` audit row, then `shellOpen` on the cell. A failed open writes a close row (`open-failed:<code>`). The plain key goes to the browser once, in the POST answer, and nowhere else.
- **Ticket** (`ticket.ts`): `tpshell.v<n>.<payload>.<sig>`, HMAC with the `shell-ticket` keyring, 30 s. It rides in `Sec-WebSocket-Protocol` (`tp-shell.v1, tp-ticket.<ticket>`), never a cookie or URL. Single use comes from the cell taking the pending open; the ticket binds sid, user and auth session.
- **Upgrade** (`upgrade.ts`): `Origin` must be the request's own host or a configured UI origin (a missing or `null` origin is refused), then the ticket. Shared by the Workers route and the self-hosted route.
- **Routes** (`src/client/terminal/routes.ts`): `POST|GET /servers/:id/terminal-sessions`, `DELETE .../:sid` (your own, or `organization:manage`), `PUT /servers/:id/terminal` (switch; turning it off kills every session with reason `switch-off`).
- The self-hosted runtime has no hub yet: `POST` answers 501 `terminal_unsupported` before any audit row.
- Cell side, tags and hibernation caveats: `src/daemon/cell/AGENTS.md`.
