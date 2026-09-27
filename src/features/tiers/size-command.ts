/**
 * The one-line shell command Add Server shows so a person can find out how
 * big a machine is **before** it enrols: run it on the server, read
 * `8 cores, 31.3 GiB RAM`. The console maps that to a tier with the
 * catalogue's bands (`entitlements.maxCores` / `maxMemoryBytes`), so the
 * command carries no thresholds and stays short.
 *
 * It must measure what placement measures, or it would suggest a tier the
 * control plane then refuses:
 *
 * - **Cores** are physical cores, never threads, counted the way the daemon's
 *   host inventory counts them (turbopaneld `src/host/host-inventory.ts`):
 *   the distinct (`physical id`, `core id`) pairs; else the sockets'
 *   `cpu cores` summed; else the processor (thread) count — the ARM boards
 *   that print no topology land there.
 * - **RAM** is `/proc/meminfo` `MemTotal` — the daemon's `memoryTotalBytes`
 *   in KiB — shown in GiB.
 *
 * POSIX awk only (gawk, mawk and busybox awk all run it), no dependencies,
 * no single quotes inside the program, nothing written anywhere.
 */

export type SizeCommandSources = Readonly<{
  cpuinfo: string
  meminfo: string
}>

const PROC_SOURCES: SizeCommandSources = {
  cpuinfo: '/proc/cpuinfo',
  meminfo: '/proc/meminfo',
}

const PROGRAM =
  '/^processor/{n++}/^physical id/{p=$2}/^core id/{c[p","$2]}/^cpu cores/{q[p]=$2}' +
  '/^MemTotal/{m=$2}' +
  'END{for(x in c)k++;if(!k)for(x in q)k+=q[x];' +
  'printf "%d cores, %.1f GiB RAM\\n",(k?k:n),m/1048576}'

/**
 * Build the command. `sources` exists for tests, which point it at fixture
 * files; the console always shows the `/proc` form ({@link SERVER_SIZE_COMMAND}).
 */
export function buildServerSizeCommand(sources: SizeCommandSources = PROC_SOURCES): string {
  return `awk -F: '${PROGRAM}' ${sources.cpuinfo} ${sources.meminfo}`
}

/** What Add Server and `GET /billing/catalog` show: run on the server, prints its cores and RAM. */
export const SERVER_SIZE_COMMAND = buildServerSizeCommand()
