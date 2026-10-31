# Platform Ports and Storage (`src/platform/`)

## Storage classification (four workloads)

Storage is chosen by **the question asked of the data**, not by the shape of the
data. A deploy transcript and a running container's stdout can both be called
"logs" and still belong in opposite classes — one is stored, one is not. Before
adding, moving, or "unifying" a store, place it in this table first — and read
the linked doc.

| # | Workload                                                       | Access pattern                                                                                  | Hosted (Workers)                    | Self-hosted (Deno)                                                    | Read before editing                |
| - | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------- | ---------------------------------- |
| 1 | **Command state** — `command` rows, status, timings, `context` | Relational, transactional, filtered/joined; source of truth                                     | Postgres via Hyperdrive             | Postgres (co-located)                                                 | `src/features/commands/AGENTS.md`       |
| 2 | **Command execution material** — the one-shot daemon payload   | Written once, read once, then deleted (~24 h on failure)                                        | Postgres `dispatch` side table      | Postgres `dispatch` side table                                        | `src/db/AGENTS.md`             |
| 3 | **Deploy/build transcript** — a command's stdout/stderr        | `GET` by known `commandId`, whole or resumed from an offset — **never scanned across commands** | R2 keyed objects (`EXECUTION_LOGS`) | Filesystem under the state tree (or S3)                               | `src/features/execution-logs/AGENTS.md` |
| 4 | **Analytics** — host metrics + connection-status events        | Aggregate over time buckets; sampled, disposable                                                | Analytics Engine                    | DuckDB + Parquet under the metrics state root (`resolveMetricsDir()`) | `src/daemon/metrics/AGENTS.md`     |

Container output is tailed live (on-demand `docker container logs` via a
correlated cell round trip) and is **never stored**. It is not a storage
workload. Operators who need history ship those bytes to their own sink — see
`../website/docs/architecture/container-logs.mdx`.

Classes 1–2 are canonical business data; 3–4 are retained telemetry and are
never load-bearing for a control-plane decision. **Postgres holds no log bytes**
— no execution-log column, no container-log table; `hasLog` is resolved
store-side. Every telemetry store resolves to a **safe no-op disabled store**
when unconfigured (`resolveExecutionLogStore` / `resolveServerMetricsStore`), so
callers never branch on availability. Public docs:
`../website/docs/architecture/storage-architecture.mdx` (plus
`deployment-logs.mdx` and `container-logs.mdx`).
