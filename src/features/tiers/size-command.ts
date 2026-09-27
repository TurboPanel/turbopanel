/**
 * The one-line shell command Add Server shows so a person can find out which
 * tier a machine needs **before** it enrols: run it on the server, read
 * `8 cores, 31.3 GiB RAM -> S2`.
 *
 * It must measure exactly what placement measures, or it would name a tier
 * the control plane then refuses:
 *
 * - **Cores** are physical cores, never threads, counted the way the daemon's
 *   host inventory counts them (turbopaneld `src/host/host-inventory.ts`):
 *   per socket (`physical id`, `"0"` when absent), the distinct `core id`s;
 *   else that socket's `cpu cores` field; else its processor (thread)
 *   count. Summed across sockets — {@link totalPhysicalCores}.
 * - **RAM** is `/proc/meminfo` `MemTotal` × 1024 — the daemon's
 *   `memoryTotalBytes`.
 * - **Tier** is the harder of the CPU band and the RAM band, from the same
 *   ladder ceilings as {@link resolveRequiredTier}; past S7 it is SX.
 *
 * POSIX awk only (gawk, mawk and busybox awk all run it), no dependencies,
 * no single quotes inside the program, nothing written anywhere. The band
 * ceilings are generated from the ladder, so a ladder change moves the
 * command with it.
 */
import { CUSTOM_TIER_LABEL, PRICED_LADDER } from './ladder.ts'

const GIB = 1024 ** 3

export type SizeCommandSources = Readonly<{
  cpuinfo: string
  meminfo: string
}>

const PROC_SOURCES: SizeCommandSources = {
  cpuinfo: '/proc/cpuinfo',
  meminfo: '/proc/meminfo',
}

/** The ceilings as whole GiB; the ladder is priced in whole GiB and the test pins it. */
function memoryCeilingsGib(): number[] {
  return PRICED_LADDER.map((entry) => entry.maxMemoryBytes / GIB)
}

/**
 * Build the command. `sources` exists for tests, which point it at fixture
 * files; the console always shows the `/proc` form ({@link SERVER_SIZE_COMMAND}).
 */
export function buildServerSizeCommand(sources: SizeCommandSources = PROC_SOURCES): string {
  const cores = PRICED_LADDER.map((entry) => entry.maxCores).join(' ')
  const memory = memoryCeilingsGib().join(' ')
  const labels = PRICED_LADDER.map((entry) => entry.label).join(' ')
  const program = [
    // One processor block ends where the next begins (or at END).
    'function f(){if(s)t[p]++;s=0}',
    'NR==FNR{k=$1;sub(/[ \\t]+$/,"",k);v=$2;sub(/^[ \\t]+/,"",v);',
    'if(k=="processor"){f();s=1;p="0"}',
    'else if(k=="physical id")p=v;',
    'else if(k=="core id"){if(!((p,v) in u)){u[p,v]=1;n[p]++}}',
    'else if(k=="cpu cores")q[p]=v;next}',
    '$1=="MemTotal"{m=$2*1024}',
    'END{f();for(x in t)c+=(n[x]?n[x]:(q[x]!=""?q[x]:t[x]));',
    'a=split(C,cc," ");split(M,mm," ");split(L,ll," ");',
    'r=a+1;for(i=1;i<=a;i++)if(c<=cc[i]+0){r=i;break}',
    'w=a+1;for(i=1;i<=a;i++)if(m<=mm[i]*1073741824){w=i;break}',
    'if(w>r)r=w;',
    `printf "%d cores, %.1f GiB RAM -> %s\\n",c,m/1073741824,(r>a?"${CUSTOM_TIER_LABEL}":ll[r])}`,
  ].join('')
  return `awk -F: -v C="${cores}" -v M="${memory}" -v L="${labels}" '${program}' ${sources.cpuinfo} ${sources.meminfo}`
}

/** What Add Server and `GET /billing/catalog` show: run on the server, prints its size and tier. */
export const SERVER_SIZE_COMMAND = buildServerSizeCommand()
