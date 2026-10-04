# Testing Checklist live-proof runner

One command re-proves the Testing Checklist rows that can be shown through the
client API (and, optionally, read-only SSH) against **testing** or **canary**.
Results come out in the `.cl-tmp/track-c/results-*.json` shape
(`[{id, verdict, evidence}]`) plus a markdown summary. With `--tick-road` the
runner also prints status docs that can be applied to the Road page.

## Safety model

- **Dry run by default.** Without `--apply` the runner sends one request,
  `GET /api/health`, prints the plan, and writes an all-`skip` result. It never
  builds an API client.
- **Hard target allowlist.** Only `https://testing.turbopanel.dev` and
  `https://canary.turbopanel.dev` are accepted. The match is an exact
  hostname, on https, with no port and no userinfo. Any other URL is refused,
  and so is a redirect to another origin.
- **Health gate.** The runner refuses unless `/api/health` says
  `environment` is `testing` or `canary`. `live`, `staging`, `production`, a
  missing value and a non-200 response are all refused (fail closed). The one
  exception: a self-hosted (Deno) panel reports `environment: null`, and that
  is accepted only when the host is exactly `canary.turbopanel.dev`. Canary
  was unreachable from the development machine when this was written, so the
  canary path is untested live.
- **Safety classes.** Every check declares one:
  - `readonly`: GET only.
  - `creates-objects`: adds panel rows and deletes them; nothing is deployed.
  - `host-affecting`: deploys, creates clusters, or changes a server.
- **What runs.**
  - `--apply` runs `readonly` and `creates-objects`.
  - `--apply --safety readonly` builds a GET-only client. Any other verb throws
    inside the client, so the check fails instead of writing.
  - `host-affecting` needs `--apply --allow-host-affecting`. It also needs the
    target server named with `--host`.
- **Host rules** (constants in `safety.ts`):
  - studio is never touched, not even over SSH.
  - adrastea and kore carry the shared managed Postgres. They are never a
    `--host` for host-affecting work and never a managed placement.
  - Managed clusters go on themisto or megaclite only.
  - UIDs and the Docker gate switch are never changed.
  - There are no metrics or analytics checks.
- **Cleanup.**
  - Each run gets a unique prefix (`clr-xxxxxxxx`), and everything a check
    creates is named with it.
  - Cleanup steps are registered by id as soon as the id is known. They unwind
    LIFO in `finally`, even when the check throws, and a failing step does not
    stop the steps after it.
  - Cleanup never searches by name, so nothing the run did not create is
    touched.
  - Cleanup failures are listed under "Cleanup failures" in the summary.
- **Ctrl-C.** The first SIGINT lets the running check stop at its next wait.
  Its cleanup still runs, the remaining checks are reported as
  `interrupted (SIGINT)`, and the lock is released. A second SIGINT exits at
  once (code 130) without cleanup.
- **Partition dead-man.** `resilience-partition` first schedules a host-side
  `systemd-run --on-active=900` unit that removes its tagged firewall rule.
  That covers a runner killed with `kill -9` or a sleeping laptop. Cleanup
  stops the unit.
- **One run at a time.**
  - `--apply` takes `$TMPDIR/turbopanel-checklist-runner.lock` with an
    exclusive create.
  - A second run is refused. A lock left by a crashed run is never taken over:
    the error names the file and the pid it holds.
- **No secrets in output.**
  - Credentials come from the process environment only.
  - Evidence is redacted before it is written: password, token, secret and
    cookie fields, and PEM private keys.
  - Test passwords and certificates are generated at run time and kept in
    memory.

## Running it

```sh
set -a; . ~/.claude/test-creds.env; set +a   # TESTING_URL/EMAIL/PASSWORD (and CANARY_*)

# plan only (default)
deno run -A scripts/checklist-runner/cli.ts

# real, read-only
deno run -A scripts/checklist-runner/cli.ts --apply --safety readonly

# read-only plus panel objects (the default --apply set)
deno run -A scripts/checklist-runner/cli.ts --apply

# host-affecting, on named servers only
deno run -A scripts/checklist-runner/cli.ts --apply --allow-host-affecting \
  --host europa --host themisto --ssh-host europa.lan
```

| Flag                     | Meaning                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--target testing`       | `testing` (default) or `canary`; reads `TESTING_*` or `CANARY_*`                                                                             |
| `--apply`                | Execute. Without it nothing beyond `/api/health` is sent                                                                                     |
| `--safety <class>`       | Highest class to run: `readonly`, `creates-objects` (default), `host-affecting`                                                              |
| `--allow-host-affecting` | Allow host-affecting checks (implies `--safety host-affecting`)                                                                              |
| `--host <name>`          | A server host-affecting checks may use. Deploys use the first one. Managed checks use the first themisto/megaclite. Repeat the flag for more |
| `--ssh-host <host>`      | Allow read-only SSH to that host (for `network-addresses`, the docker cross-check, daemon stop/start, partition)                             |
| `--only a,b`             | Run only these row ids                                                                                                                       |
| `--out <dir>`            | Output directory (default `$TMPDIR/turbopanel-checklist-runs`)                                                                               |
| `--tick-road`            | Also write `results-<prefix>.road.jsonl` and print it                                                                                        |
| `--list`                 | Print the registry: row id, safety class, required capabilities                                                                              |

Optional environment:

- `MAILPIT_URL`: a **loopback** URL to the testing Mailpit API. Mailpit
  listens on the instance's 127.0.0.1, so open a tunnel first, e.g.
  `ssh -L 8025:127.0.0.1:8025 <testing host>`, then set
  `MAILPIT_URL=http://127.0.0.1:8025`. Without it the mail checks skip. The
  runner only ever GETs from Mailpit.
- `CHECKLIST_SSH_USER` and `CHECKLIST_SSH_IDENTITY`: the SSH user and key.
  Otherwise `~/.ssh/config` decides. SSH runs in batch mode with
  `StrictHostKeyChecking=yes`.

Exit codes: `0` means everything ran passed or skipped. `1` means at least one
check failed. `2` means the run was refused (safety, lock or usage).

## Road page hook (`--tick-road`)

The runner never writes to the Road page itself. With `--tick-road` it prints
one JSON line per **pass or fail** (skips are never emitted, so a skip cannot
overwrite a recorded verdict):

```json
{
  "action": "set",
  "collection": "status",
  "doc_id": "<row id>",
  "data": { "state": "pass", "note": "checklist-runner clr-…: …", "updatedAt": "…" }
}
```

The orchestrator applies these to the Road artifact database (collection
`status`, doc id = row id; the same `{state, note, updatedAt}` shape as
`.cl-tmp/road2/status/*.json`) as one ArtifactData batch.

## Checks

| Row                        | Class           | What it proves                                                                                                                                                          |
| -------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet-overview`           | readonly        | All servers (studio excluded) connected with OS/docker versions. Optional SSH cross-check of docker                                                                     |
| `fleet-daemon-update`      | readonly        | `/servers/updates`: no server has an update available                                                                                                                   |
| `ops-audit`                | readonly        | Org audit returns entries with actor, action and time                                                                                                                   |
| `ops-container-logs`       | readonly        | `logs?tail=20` works on up to 3 service containers plus 1 ingress container                                                                                             |
| `network-addresses`        | readonly        | Every reported address is in `ip -j addr` (needs `--ssh-host`)                                                                                                          |
| `hosting-upload-cert`      | creates-objects | Upload of a locally minted cert and key. The key never comes back. A mismatched key gets 400                                                                            |
| `hosting-self-signed`      | creates-objects | Self-signed mint carries the requested name                                                                                                                             |
| `managed-pg-dr`            | creates-objects | The DR promote route reaches its handler with a session (not 401). It POSTs to a nonexistent environment and writes nothing. **Route-auth probe only**                  |
| `projects-create`          | creates-objects | Every catalog template scaffolds a default environment with services                                                                                                    |
| `projects-environments`    | creates-objects | Add, rename and delete an environment                                                                                                                                   |
| `auth-signup`              | creates-objects | Weak password refused. Signup, then the mailed verify link, then sign-in. A replayed link is reported (needs `MAILPIT_URL`)                                             |
| `auth-password-change`     | creates-objects | Wrong current password 400. Change 200. Old password 401. Other session 401. Forgot, mail, reset, sign-in (needs `MAILPIT_URL`)                                         |
| `fleet-hostname`           | host-affecting  | Rename, then the console shows it. Reverted in cleanup                                                                                                                  |
| `fleet-offline-online`     | host-affecting  | `systemctl stop/start turbopaneld` flips `connected` (needs `--ssh-host`)                                                                                               |
| `resilience-partition`     | host-affecting  | iptables/ip6tables egress DROP for the daemon's uid (tagged with the run prefix). The server goes offline, a ping is refused, then it heals online (needs `--ssh-host`) |
| `backups-schedule-volume`  | host-affecting  | Docker volume copy plus a `*/2` policy: a manual backup succeeds and the timer records a run                                                                            |
| `deploy-image`             | host-affecting  | whoami deploy, a noCache redeploy, a running container, logs and history                                                                                                |
| `deploy-dockerfile`        | host-affecting  | Compose `build:` from a git context (docker/welcome-to-docker): build log streams, the redeploy reuses the image. The body is inferred from the earlier manual proof    |
| `deploy-ports`             | host-affecting  | `ports: ["<p>:80"]` is reachable from the runner and closed after stop                                                                                                  |
| `deploy-native-node`       | host-affecting  | Native node unit deploys. The hostname is served (curl over `--ssh-host`)                                                                                               |
| `deploy-native-next`       | host-affecting  | Next.js build and start deploys and is served                                                                                                                           |
| `deploy-site-nginx`        | host-affecting  | Static git site on nginx                                                                                                                                                |
| `deploy-site-nginx-php`    | host-affecting  | nginx + PHP managed-directory site                                                                                                                                      |
| `deploy-site-apache`       | host-affecting  | Apache + PHP managed-directory site                                                                                                                                     |
| `deploy-managed-dir`       | host-affecting  | Caddy managed-directory site                                                                                                                                            |
| `deploy-source-release`    | host-affecting  | Two releases, then a rollback to the earlier one; the live release flips                                                                                                |
| `managed-pg-single`        | host-affecting  | Postgres reaches ready. The root password is in the create response only                                                                                                |
| `managed-mysql`            | host-affecting  | Same for MySQL                                                                                                                                                          |
| `managed-mariadb`          | host-affecting  | Same for MariaDB                                                                                                                                                        |
| `managed-pg-users`         | host-affecting  | Create and drop a database and an owner user                                                                                                                            |
| `managed-logs`             | host-affecting  | `managed/logs?tail=50` returns engine logs                                                                                                                              |
| `managed-lifecycle`        | host-affecting  | Stop, start, destroy. The row is gone afterwards                                                                                                                        |
| `backups-schedule-managed` | host-affecting  | `*/2` policy on a fresh cluster: a manual backup succeeds and the timer records a run                                                                                   |

### Known leftovers

- **Signed-up users.** The panel has no account delete, so the users that
  `auth-*` checks sign up (`clr-…@example.com`) remain.
- **Unix principals.** Native and site deploys create one on the host. It
  stays after environment delete; remove it by hand with `userdel`.
- **Docker volumes.** `backups-schedule-volume` may leave the docker volume
  on the host after storage delete. Earlier manual runs had to remove one by
  hand.

### Not automated (and why)

| Row                                                                | Reason                                                                                                                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet-hardware-profile`                                           | Its routes live under `/servers/:id/metrics/*`. The runner has no metrics checks by rule                                                             |
| `managed-pg-dr` (end to end)                                       | It needs an HA cluster with a `read` replica across two hosts, then a promote and a check of the old primary. Only the route-auth probe is automated |
| `managed-pg-failover`, `managed-pg-promote`, `managed-pg-proxysql` | Each needs a two-host HA cluster and stopping a primary container over SSH. Too invasive to run unattended                                           |
| `managed-*` connect over TLS                                       | Needs a database client on the runner. Readiness and one-time credential exposure are checked instead                                                |
| `auth-signin`, `auth-redirect`, `auth-signin-throttle`             | Throttling from the runner's IP could lock the operator out. The redirect and cookie rows are covered by `turbopanel#160` tests                      |
| `fleet-reboot`, `backups-reboot-catchup`, `storage-volumes`        | They reboot a host. Kept manual                                                                                                                      |
| `resilience-clock-skew`, disk-full proofs                          | They change host clock or disk state. Kept manual                                                                                                    |
| `fleet-daemon-update` (performing an update)                       | Updates are `409 updates_managed` on Workers (testing). The check only reads update state                                                            |
| UI-only rows (status dots, picker defaults)                        | Not provable through the API                                                                                                                         |
| billing, email channel, org-invite rows                            | Need Stripe test clocks, outside mailboxes or second accounts. Not in scope                                                                          |

## Layout

- `cli.ts`: argument parsing, environment, health gate, lock, outputs.
- `safety.ts`: allowlists, gates, redaction.
- `http.ts`: the only door to the panel. It handles the org scope, the cookie
  jar, the reauth retry on DELETE, one retry on a DNS error, the redirect
  guard and read-only mode.
- `runner.ts`: plan, sequential run, cleanup stack, markdown and road output.
- `lock.ts` and `adapters.ts`: run lock, Mailpit, SSH and the port probe.
- `checks/*.ts`: the registry (`checks/index.ts`).
- `framework.hostfree.test.ts`: unit tests with injected fakes. It runs on the
  host-free CI shard.
