# Daemon surface — AGENTS.md

`src/daemon/` is the **control-plane side** of the daemon protocol
(`/api/daemon/v1`, `/ws/daemon/v1`). It is **not** the TurboPanel Daemon
checkout (`turbopaneld`). Keep the directory name: it matches the URL prefix.

Nested docs:

| Area | Read first |
| --- | --- |
| Cell (presence, DO + Redis, hibernation/cost) | `cell/AGENTS.md` |
| Host-metrics ingest + stores | `metrics/AGENTS.md` |

## Producer-owns

Wire shapes are owned by **one** repo. The other copies them (or drift-checks
them). Do not “fix” a shape in the consumer and leave the producer behind.

| Shape | Owner | Copy / check |
| --- | --- | --- |
| Command payload + result schemas | **this repo** (`src/contracts/commands/`) | daemon rewrites a twin under `turbopaneld/src/contracts/` |
| Cell protocol (`DaemonMessage`, envelopes) | **this repo** (`src/contracts/cell-protocol.ts`, `src/contracts/cell.ts`) | daemon extracts a twin; fields the daemon added (`hello`/`heartbeat`, `drivetemp`) stay daemon-local until this repo adopts them |
| Metrics contract | **daemon** (`turbopaneld/src/contracts/metrics-contract.ts`) | this repo vendors a **byte-identical** twin (`src/contracts/metrics-contract.ts`); CI compares bodies below the header |
| Topology types + slot mapping | **daemon** | this repo drift-checks `src/contracts/topology-*.ts` |

CI:

- Instance: `pnpm check:contract-drift`
- Daemon: `deno task check:contract-drift`

When adding a field the daemon discovers (host facts, metrics, topology),
change `turbopaneld` first, then copy/check here. When adding a command the
control plane enqueues, change this repo first, then the daemon twin.

## What stays here

- REST + WS entry (`api-routes.ts`, `deno-ws.ts`, `workers-ws.ts`)
- Durable Object + Redis cell pair (`cell/` — four path pins; do not move)
- Daemon JWT authn (`authn/`)
- Metrics **ingest** (control-plane store + query). Discovery of what to
  sample lives on the daemon.

### Co-location is not the transport

A **co-located** daemon runs on the control plane's own host. Whether it
_reaches_ the instance over the Unix socket is a separate fact, and it follows
the runtime:

| Runtime                     | Co-located daemon connects via                      | Stored peer address                     |
| --------------------------- | --------------------------------------------------- | --------------------------------------- |
| Deno (self-hosted)          | `/run/turbopanel/instance.sock`                     | `__direct__` (`DIRECT_ATTACH_SENTINEL`) |
| Workers (High Availability) | HTTPS/WSS to the hosted URL, like any remote daemon | its real peer address                   |

`shapeServerPresenceFields` therefore takes the transport from
`presence.directAttach` (the stored peer address _was_ the sentinel), narrowed
by the deployment — never from `colocated`:

- **`colocated` must not substitute the sentinel.** It used to, which labelled a
  co-located host on Workers "via Local Unix Socket" for a connection that never
  touched a socket.
- **`directAttach` is ignored when the deployment is hosted.** Only the Deno
  transport writes the sentinel, so on Workers it is necessarily a stale row
  from a control plane that used to run on Deno — precisely what a development
  instance switching runtimes leaves behind. Believing it pins the co-located
  host to the socket label until something else rewrites the projection, and
  under `wrangler dev` nothing does:
  `resolvePeerAddress(…, {runtime:'workers'})` reads `CF-Connecting-IP` only,
  and the dev Caddy in front of wrangler sends `X-Real-IP`, so
  `identity.remoteAddress` arrives undefined and `postgres-projection.ts` keeps
  whatever was there.

The console's connection line follows `addressSource === 'local'` for the same
reason.

Identity guards are the other way round: "you may not delete, or remotely
update, the host this control plane runs on" must hold on **both** runtimes, so
they pass `includeSelfHostPin: true` to `resolveColocatedServerIdSet`. The pin
is the `turbopanel` system environment — plain SQL that works on Workers, where
the transport probes (`__direct__`, `/etc/machine-id`, `Deno.hostname()`) all
come up empty. The cached read models deliberately do _not_ pass it, so their
approved-SQL profile stays unchanged; their `colocatedWithInstance` is a display
badge, not a guard.
