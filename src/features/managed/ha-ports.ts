/**
 * Host ports reserved for the per-org Orchestrator Raft group.
 * Published only on private / TurboFabric addresses — never 0.0.0.0 public.
 * Keep out of ProxySQL listeners, admin, and the 45000–45999 private-engine range.
 */
export const MANAGED_HA_HTTP_PORT = 33001
export const MANAGED_HA_RAFT_PORT = 33002
