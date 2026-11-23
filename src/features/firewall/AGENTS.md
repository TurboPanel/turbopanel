# Firewall (`src/features/firewall/`)

## Outside reachability check (`probe-run.ts`)

"Check now" dials a server's addresses from the control plane. It must never
become a way to scan the operator's network.

- `ip` rows have **no provenance**: `POST /ips` lets anyone with create
  permission add any address to their own server. They are input, not proof.
- A **private** address (RFC 1918, CGNAT, ULA) is dialled only when it is also
  one of the addresses the server's own daemon reported
  (`server.metadata.resources.ips`, read with `reportedIpsFromServerMetadata`,
  compared in canonical form). A hand-made `10.0.0.5` row on a server whose
  daemon never reported it is skipped. LAN servers keep working because their
  daemon reports the LAN address.
- Public addresses behave as before. A control plane host's own interface
  addresses (`TcpProbe.localAddresses`) are refused for every server except the
  co-located one (`plan.coLocated`).
- Every address left out is returned in `probe.skipped` (`address`, `reason`)
  and in `notes`; nothing is dropped silently. The same `skipReason` predicate
  picks the targets and re-checks each one just before dialling. All refusals
  share one reason text (`SKIP_REASON_REFUSED`) on purpose: `POST /ips` takes any
  address, so a distinct reason for a control plane host address would let a
  tenant enumerate that host's interfaces. Never add a distinguishing reason to
  the response or `notes`; log it server-side if it is ever needed. Only the
  per-server cap has its own text. The host's interface addresses are read once
  per round.
- Residual: a compromised daemon can report addresses it does not own. Closing
  that needs an owner-confirmed network list per datacenter, not more checks here.
- Enforcement gating (`FIREWALL_APPLY_ENABLED`) is untouched by this module.
