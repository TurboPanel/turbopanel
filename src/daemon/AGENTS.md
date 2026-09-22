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
