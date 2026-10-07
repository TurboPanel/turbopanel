// Spec tooling, not shipped. Layout model extracted from the owner-sealed "Metrics Schema Audit"
// artifact row explorer (UI code removed, slot ids added). Driven by generate.mjs.

'use strict';
/* ---------- Categories: letter + colour per square ---------- */
const CATS = {
  C:{name:'CPU'}, M:{name:'Memory'}, I:{name:'Disk I/O'}, S:{name:'Disk space'}, N:{name:'Network'},
  L:{name:'Kernel limits'}, D:{name:'Docker'}, W:{name:'Web traffic (Caddy / Traefik)'}, B:{name:'Databases'},
  T:{name:'Sensors'}, H:{name:'Host health'}, G:{name:'GPU'}
};

/* ---------- Field catalogue (turbopanel 902236d metric-descriptors.ts / field-map.ts; v7 additions marked) ---------- */
const F = {};
function def(scope, cat, rows){
  rows.trim().split('\n').forEach(line => {
    const [name, unit, agg, desc, c] = line.trim().split('|');
    F[scope + '.' + name] = {name, scope, unit, agg, desc, cat: c || cat};
  });
}
def('host.cpu','C',`
busyPercent|%|avg|Share of CPU time not idle, across all cores.
userPercent|%|avg|Time spent in user-space processes.
systemPercent|%|avg|Time spent in the kernel.
iowaitPercent|%|avg|Idle time spent waiting on disk I/O.
stealPercent|%|avg|Time the hypervisor gave this VM's vCPUs to someone else. The key noisy-neighbour signal on a VPS; zero on physical hosts.
softirqPercent|%|avg|Time servicing soft interrupts, mostly network.
pressureSomePercent|%|avg|CPU pressure (PSI some): share of time at least one task waited for a CPU.
saturatedCoreCount|count|avg|Cores running at or near 100%.
procsRunning|count|avg|Runnable tasks.
procsBlocked|count|avg|Tasks blocked on I/O. IO pressure measures the same thing directly.
processCount|count|avg|Total processes. Only meaningful against the PID limit.
pidLimitUsedPercent|%|avg|Processes and threads as a share of the kernel PID limit. A stock Netdata alert. New in v7.|L`);
def('host.memory','M',`
usedBytes|bytes|avg|Memory in use, excluding page cache.
cachedFilesBytes|bytes|avg|Page cache holding file data.
swapUsedBytes|bytes|avg|Swap in use. Zero is a real value.
pressureSomePercent|%|avg|Memory pressure (PSI some).
pressureFullPercent|%|avg|Memory pressure (PSI full): every task stalled at once.
swapInBytesPerSecond|B/s|avg|Swap read rate.
swapOutBytesPerSecond|B/s|avg|Swap write rate.
majorPageFaultsPerSecond|/s|avg|Page faults that had to read from disk.
oomKills|count|sum|Processes the kernel OOM killer ended in the interval (/proc/vmstat oom_kill). The memory "errors" signal. New in v7.`);
def('host.kernel','L',`
fileHandlesUsedPercent|%|avg|Open file handles as a share of the kernel limit.
conntrackUsedPercent|%|avg|Connection-tracking table fill. When it is full, new connections are dropped.`);
def('host.storage','I',`
ioPressureSomePercent|%|avg|IO pressure (PSI some).
ioPressureFullPercent|%|avg|IO pressure (PSI full).
diskReadBytesPerSecond|B/s|avg|Read rate summed over the host's disks.
diskWriteBytesPerSecond|B/s|avg|Write rate summed over the host's disks.
diskLatencyMs|ms|avg|Average disk request latency across disks.
rootFilesystemAvailableBytes|bytes|avg|Free space on /.|S
rootFilesystemFreeInodes|count|avg|Free inodes on /.|S`);
def('host.network','N',`
tcpRetransmitPercent|%|avg|Share of TCP segments retransmitted.
softnetDropsPerSecond|/s|avg|Packets the kernel dropped before processing them (backlog full).`);
def('nic','N',`
rx|B/s|avg|Receive rate.
tx|B/s|avg|Transmit rate.
problems|/s|avg|Receive and transmit errors plus drops, summed into one value. Null if any input is missing.`);
def('network','N',`
receiveBytesPerSecond|B/s|avg|Receive rate.
transmitBytesPerSecond|B/s|avg|Transmit rate.
receiveErrorsPerSecond|/s|avg|Receive errors.
transmitErrorsPerSecond|/s|avg|Transmit errors.
receiveDropsPerSecond|/s|avg|Receive drops.
transmitDropsPerSecond|/s|avg|Transmit drops.`);
def('filesystem','S',`
availableBytes|bytes|avg|Free space on this filesystem.
freeInodes|count|avg|Free inodes on this filesystem.
totalBytes|bytes|avg|Size of this filesystem when the sample was taken. The divisor of its used percentage. New in v7 (sizes amendment).
totalInodes|count|avg|Inodes this filesystem has when the sample was taken. New in v7 (sizes amendment).`);
def('host.io','I',`
rootDiskQueueDepth|count|avg|Requests queued at the disk that holds /. The saturation signal for NVMe and virtual disks. New in v7.
rootDiskOpsPerSecond|/s|avg|Read plus write operations per second on that disk. Providers cap IOPS. New in v7.`);
def('diagnostics','C',`
averageFrequencyMHz|MHz|avg|Average core clock. On a VM it is whatever the hypervisor exposes, usually a fixed nominal clock.
minimumFrequencyMHz|MHz|avg|Slowest core clock.
maximumFrequencyMHz|MHz|avg|Fastest core clock.
contextSwitchesPerSecond|/s|avg|Context switches.
interruptsPerSecond|/s|avg|Hardware interrupts.
forksPerSecond|/s|avg|New processes.
cpuIrqPercent|%|avg|CPU time in hard interrupts.
memoryFreeBytes|bytes|avg|Completely unused memory (MemFree).|M
cachedBytes|bytes|avg|Page cache (Cached). Overlaps host.memory cachedFilesBytes.|M
anonPagesBytes|bytes|avg|Anonymous memory (heap and stack).|M
slabReclaimableBytes|bytes|avg|Kernel slab memory that can be freed.|M
slabUnreclaimableBytes|bytes|avg|Kernel slab memory that cannot be freed.|M
dirtyBytes|bytes|avg|Data waiting to be written to disk.|M
writebackBytes|bytes|avg|Data being written to disk right now.|M
shmemBytes|bytes|avg|Shared memory and tmpfs.|M
committedAsBytes|bytes|avg|Memory promised to processes (Committed_AS).|M
pageScanDirectPerSecond|/s|avg|Pages scanned by allocating tasks themselves.|M
pageScanKswapdPerSecond|/s|avg|Pages scanned by the background reclaimer.|M
compactionStallsPerSecond|/s|avg|Allocations that stalled for memory compaction.|M`);
def('storage','S',`
hostingUsedBytes|bytes|avg|Bytes under the hosting root. Directory walk every 15 min, repeated every sample.
backupUsedBytes|bytes|avg|Bytes under the backup root.
dockerUsedBytes|bytes|avg|Docker data-root total, from the 5-minute df read.
logsUsedBytes|bytes|avg|Bytes under the log directory.
hostingFreeBytes|bytes|avg|Free space on the filesystem that holds the hosting root.
backupFreeBytes|bytes|avg|Free space on the backup filesystem.
logsFreeBytes|bytes|avg|Free space on the log filesystem.`);
['postgres','mysql','mariadb'].forEach(e => {
  const E = {postgres:'Postgres',mysql:'MySQL',mariadb:'MariaDB'}[e];
  def('storage','B',`
${e}InstancesRunning|count|avg|Managed ${E} instances running.
${e}InstancesHealthy|count|avg|Managed ${E} instances passing health checks.
${e}ConnectionsUsed|count|avg|Connections open across managed ${E} instances.
${e}ConnectionsMax|count|avg|Connection limit across managed ${E} instances.`);
});
def('docker','D',`
layersBytes|bytes|avg|Image layers on disk.
imagesCount|count|avg|Images present.
imagesReclaimableBytes|bytes|avg|Image bytes not used by any container.
containersBytes|bytes|avg|Container writable layers.
containersCount|count|avg|All containers, running or stopped.
volumesBytes|bytes|avg|Volume data.
volumesCount|count|avg|Volumes present.
volumesReclaimableBytes|bytes|avg|Volume bytes not mounted by any container.
buildCacheBytes|bytes|avg|Build cache.
buildCacheReclaimableBytes|bytes|avg|Build cache that can be pruned.
reclaimableBytes|bytes|avg|Images, volumes and build cache Docker could reclaim, summed. From df, refreshed slowly with a timeout.
containersRunning|count|avg|Containers running (GET /info). New in v7.
containersUnhealthy|count|avg|Running containers whose healthcheck reports unhealthy (/containers/json health filter). New in v7.
containersRestarting|count|avg|Containers in a restart loop. New in v7.
containerOomEvents|count|sum|Container OOM kills in the interval, counted from the Docker events stream. New in v7.
containerDieEvents|count|sum|Container exits in the interval, from the events stream. New in v7.`);
def('health','H',`
systemdUnitsFailed|count|avg|Failed systemd units. The service-health signal for native nginx, Apache, OpenLiteSpeed, php-fpm and Node sites. New in v7.
mdArraysDegraded|count|avg|Software RAID arrays running degraded (/proc/mdstat). New in v7.
mdArraysResyncing|count|avg|Software RAID arrays resyncing or rebuilding. New in v7.`);
def('ingress','W',`
requests|count|sum|Requests Caddy handled in the interval. Includes everything Traefik serves, plus native and static sites.
responses2xx|count|sum|2xx responses.
responses3xx|count|sum|3xx responses.
responses4xx|count|sum|4xx responses.
responses5xx|count|sum|5xx responses.
requestErrors|count|sum|Requests that failed before a response.
requestBytes|bytes|sum|Request bytes received.
responseBytes|bytes|sum|Response bytes sent.
requestDurationSecondsSum|s|sum|Total time spent serving requests; divided by requests at read time for the mean.
bucket10ms|count|sum|Requests finished within 10 ms (cumulative histogram bucket).
bucket50ms|count|sum|Requests finished within 50 ms.
bucket100ms|count|sum|Requests finished within 100 ms.
bucket500ms|count|sum|Requests finished within 500 ms.
bucket1s|count|sum|Requests finished within 1 s.
bucket5s|count|sum|Requests finished within 5 s.
requestsInFlight|count|avg|Requests in progress.
upstreamsHealthy|count|avg|Caddy upstreams passing health checks. With Docker the only upstream is Traefik, so this says little.
upstreamsTotal|count|avg|Caddy upstreams configured.
retries|count|sum|Upstream retries. Caddy exports no retries metric, so this is always empty in practice.
backendsUp|count|avg|Backends up: from Traefik when Docker runs, otherwise Caddy's upstream health gauge. Moved here in v7.
backendsTotal|count|avg|Backends configured, from the same source. Moved here in v7.
tlsCertSoonestExpiryDays|days|avg|Days until the soonest certificate expires. Moved here from the Traefik row in v7.`);
def('router','W',`
backendsUp|count|avg|Traefik backends up.
backendsTotal|count|avg|Traefik backends configured.
servicesTotal|count|avg|Services configured.
routersTotal|count|avg|Routers configured.
retries|count|sum|Backend retries.
backendErrors5xx|count|sum|5xx responses from container backends.
backendLatencyMsAvg|ms|avg|Mean backend latency.
backendRequests|count|sum|Requests forwarded to containers. Already counted by Caddy.
httpOpenConnections|count|avg|Open HTTP connections.
configReloads|count|sum|Configuration reloads.
configLastReloadAgeSeconds|s|avg|Seconds since the last reload.
tlsCertSoonestExpiryDays|days|avg|Days until the soonest certificate expires.`);
def('proxy','B',`
queries|count|sum|Queries through ProxySQL.
slowQueries|count|sum|Queries over the slow threshold.
queryLatencyMsAvg|ms|avg|Mean query latency.
backendLatencyMsAvg|ms|avg|Mean backend latency.
activeTransactions|count|avg|Open transactions.
clientConnections|count|avg|Client connections open.
clientConnectionsCreated|count|sum|Client connections opened.
clientConnectionsAborted|count|sum|Client connections aborted.
connectionsRejectedMaxConns|count|sum|Connections refused at the limit.
backendConnections|count|avg|Backend connections open.
backendConnectionsCreated|count|sum|Backend connections opened.
backendConnectionsAborted|count|sum|Backend connections aborted.
connectionErrors|count|sum|Connection errors.
backendsUp|count|avg|Database backends up.
backendsTotal|count|avg|Database backends configured.
bytesFromBackends|bytes|sum|Bytes received from databases.
bytesToBackends|bytes|sum|Bytes sent to databases.`);
def('block','I',`
readBytesPerSecond|B/s|avg|Read rate for this drive.
writeBytesPerSecond|B/s|avg|Write rate for this drive.
readOpsPerSecond|/s|avg|Read operations per second.
writeOpsPerSecond|/s|avg|Write operations per second.
readLatencyMs|ms|avg|Mean read latency.
writeLatencyMs|ms|avg|Mean write latency.
utilizationPercent|%|avg|Time the drive was busy. Misleading on NVMe and virtual disks, which serve requests in parallel.
queueDepth|count|avg|Requests queued at the drive. The saturation signal.
opsPerSecond|/s|avg|Read plus write operations per second. New in v7 (summed).`);
def('gpu','G',`
utilizationPercent|%|avg|GPU busy time.
memoryUsedBytes|bytes|avg|GPU memory in use.
memoryActivityPercent|%|avg|GPU memory controller activity.
pcieReceiveBytesPerSecond|B/s|avg|PCIe receive rate.
pcieTransmitBytesPerSecond|B/s|avg|PCIe transmit rate.
throttlePercent|%|avg|Time the GPU was throttled.
memoryTotalBytes|bytes|avg|GPU memory size when the sample was taken. The divisor of its used percentage. New in v7 (sizes amendment).`);
def('extended.sizes','M',`
memoryTotalBytes|bytes|avg|Total memory when the sample was taken (MemTotal). The divisor of memory used. A balloon or resize changes it between samples.
swapTotalBytes|bytes|avg|Total swap when the sample was taken. The divisor of swap used.
commitLimitBytes|bytes|avg|CommitLimit from /proc/meminfo. The divisor of committed memory.
logicalCores|count|avg|Logical CPU count when the sample was taken. The divisor of the saturated-core count.
rootFilesystemTotalBytes|bytes|avg|Size of / when the sample was taken. The divisor of root disk used.
rootFilesystemTotalInodes|count|avg|Inodes on / when the sample was taken. The divisor of root inodes used.`);
const INTERVAL = {name:'interval', unit:'s', agg:'weight', desc:'Sample interval in seconds: 60 normally, 10 while a live lease is open. Every reader weights by it.'};
const L = (scope, name) => { const f = F[scope + '.' + name]; if (!f) throw new Error('no field ' + scope + '.' + name); return f; };
function sig(id, desc, unit, isNew){ return {name: id, scope:'hardwareSignal', unit: unit || '°C', agg:'avg', cat:'T', desc: desc + (isNew ? ' New in v7.' : '')}; }

/* ---------- Slot builders ---------- */
const sl = (field, group, opt) => Object.assign({f:field, g:group, st:'live'}, opt || {});
const spare = note => ({f:null, g:null, st:'spare', note: note || 'Reserved spare slot, written as the -1e308 sentinel.'});
const pageEmpty = () => ({f:null, g:null, st:'spare', note:'Page not full: this slot stays at the sentinel.'});
const many = (scope, names, group, opt) => names.map(n => sl(L(scope, n), group, opt));
const nul = (s, note) => Object.assign({}, s, {st:'null', note});
const fill = a => { while (a.length < 19) a.push(pageEmpty()); return a; };

const CPU6 = ['busyPercent','userPercent','systemPercent','iowaitPercent','stealPercent','softirqPercent','pressureSomePercent','saturatedCoreCount','procsRunning'];
const MEM8 = ['usedBytes','cachedFilesBytes','swapUsedBytes','pressureSomePercent','pressureFullPercent','swapInBytesPerSecond','swapOutBytesPerSecond','majorPageFaultsPerSecond'];
const STOR = ['ioPressureSomePercent','ioPressureFullPercent','diskReadBytesPerSecond','diskWriteBytesPerSecond','diskLatencyMs','rootFilesystemAvailableBytes','rootFilesystemFreeInodes'];
const DIAG = ['averageFrequencyMHz','minimumFrequencyMHz','maximumFrequencyMHz','contextSwitchesPerSecond','interruptsPerSecond','forksPerSecond','cpuIrqPercent','memoryFreeBytes','cachedBytes','anonPagesBytes','slabReclaimableBytes','slabUnreclaimableBytes','dirtyBytes','writebackBytes','shmemBytes','committedAsBytes','pageScanDirectPerSecond','pageScanKswapdPerSecond','compactionStallsPerSecond'];
const FLAT = ['hostingUsedBytes','backupUsedBytes','dockerUsedBytes','logsUsedBytes','hostingFreeBytes','backupFreeBytes','logsFreeBytes'];
const DOCKER = ['layersBytes','imagesCount','imagesReclaimableBytes','containersBytes','containersCount','volumesBytes','volumesCount','volumesReclaimableBytes','buildCacheBytes','buildCacheReclaimableBytes'];
const TRAFFIC = ['requests','responses2xx','responses3xx','responses4xx','responses5xx','requestErrors','requestBytes','responseBytes','requestDurationSecondsSum','bucket10ms','bucket50ms','bucket100ms','bucket500ms','bucket1s','bucket5s','requestsInFlight'];
const BLOCK = ['readBytesPerSecond','writeBytesPerSecond','readOpsPerSecond','writeOpsPerSecond','readLatencyMs','writeLatencyMs','utilizationPercent','queueDepth'];
const BLOCK7 = ['readBytesPerSecond','writeBytesPerSecond','opsPerSecond','readLatencyMs','writeLatencyMs','queueDepth'];
const PROXY = ['queries','slowQueries','queryLatencyMsAvg','backendLatencyMsAvg','activeTransactions',null,'clientConnections','clientConnectionsCreated','clientConnectionsAborted','connectionsRejectedMaxConns','backendConnections','backendConnectionsCreated','backendConnectionsAborted','connectionErrors',null,'backendsUp','backendsTotal','bytesFromBackends','bytesToBackends'];

function nics(m){
  const out = [];
  [0,1].forEach(i => {
    const n = m.nics[i];
    ['rx','tx','problems'].forEach(k => out.push(n ? sl(L('nic',k), 'NIC ' + n) : sl(L('nic',k), 'NIC slot ' + (i+1), {st:'null', note:'No NIC for embed slot ' + (i+1) + ' on this machine, so the value is written as null.'})));
  });
  return out;
}
function hostSystem(v7){
  const cpu = many('host.cpu', CPU6, 'CPU');
  const mem = many('host.memory', MEM8, 'Memory');
  if (!v7) return [...cpu, ...many('host.cpu',['procsBlocked','processCount'],'CPU'), ...mem];
  return [...cpu, ...mem, sl(L('host.memory','oomKills'),'Memory',{nw:true}), sl(L('host.cpu','pidLimitUsedPercent'),'Kernel limits',{nw:true})];
}
function hostIo(m, v7){
  if (v7) return [
    ...many('host.storage', STOR.slice(0, 5), 'Disk I/O'),
    sl(L('host.io','rootDiskQueueDepth'),'Disk I/O',{nw:true}),
    sl(L('host.io','rootDiskOpsPerSecond'),'Disk I/O',{nw:true}),
    ...many('host.storage', STOR.slice(5), 'Root filesystem'),
    ...many('host.network',['tcpRetransmitPercent','softnetDropsPerSecond'],'Network stack'),
    ...nics(m),
    ...many('host.kernel',['fileHandlesUsedPercent','conntrackUsedPercent'],'Kernel limits')
  ];
  return [
    ...many('host.kernel',['fileHandlesUsedPercent','conntrackUsedPercent'],'Kernel limits'),
    ...many('host.storage', STOR, 'Disk + root fs'),
    v7 ? sl(L('host.io','rootDiskQueueDepth'),'Root disk',{nw:true}) : spare('Spare held for host.storage growth (HOST_IO_SPARE_SLOT).'),
    ...many('host.network',['tcpRetransmitPercent','softnetDropsPerSecond'],'Network stack'),
    v7 ? sl(L('host.io','rootDiskOpsPerSecond'),'Root disk',{nw:true}) : spare('Spare held for host.network growth.'),
    ...nics(m)
  ];
}
function storageRow(m, o){
  const out = many('storage', FLAT, 'Directories');
  if (!o.docker) out[2] = nul(out[2], 'No Docker on this host.');
  ['postgres','mysql','mariadb'].forEach(e => {
    const E = {postgres:'Postgres',mysql:'MySQL',mariadb:'MariaDB'}[e];
    ['InstancesRunning','InstancesHealthy','ConnectionsUsed','ConnectionsMax'].forEach(k => {
      const s = sl(L('storage', e + k), E + ' census');
      out.push(o.db && e === 'postgres' ? s : nul(s, 'No managed ' + E + ' on this host; written as null every sample.'));
    });
  });
  return out;
}
function dockerRow(){ return [...many('docker', DOCKER, 'Docker df'), ...Array.from({length:9}, () => spare('Spare reserved for per-image / per-volume rollups.'))]; }
function footprint(m, o){
  const out = many('storage', FLAT, 'Directories');
  if (!o.docker) out[2] = nul(out[2], 'No Docker on this host.');
  const dk = [['containersRunning',1],['containersUnhealthy',1],['containersRestarting',1],['containerOomEvents',1],['containerDieEvents',1],['layersBytes',0],['volumesBytes',0],['buildCacheBytes',0],['reclaimableBytes',1]];
  dk.forEach(([n, isNew]) => {
    let s = sl(L('docker', n), 'Docker', isNew ? {nw:true} : {});
    if (!o.docker) s = nul(s, 'No Docker on this host: null, at no extra cost.');
    out.push(s);
  });
  ['systemdUnitsFailed','mdArraysDegraded','mdArraysResyncing'].forEach(n => {
    let s = sl(L('health', n), 'Host health', {nw:true});
    if (n !== 'systemdUnitsFailed' && !m.raid) s = nul(s, 'No software RAID on this host.');
    out.push(s);
  });
  return out;
}
function ingressRow(v7, o){
  const out = many('ingress', TRAFFIC, 'Caddy traffic');
  if (!v7) return [...out, ...many('ingress',['upstreamsHealthy','upstreamsTotal','retries'],'Caddy upstreams')];
  const src = o.docker ? 'Traefik backends' : 'Caddy upstreams';
  return [...out, sl(L('ingress','backendsUp'), src, {nw:true}), sl(L('ingress','backendsTotal'), src, {nw:true}), sl(L('ingress','tlsCertSoonestExpiryDays'),'TLS',{nw:true})];
}
function routerRow(){
  const R = n => sl(L('router', n), ['configReloads','configLastReloadAgeSeconds','tlsCertSoonestExpiryDays'].includes(n) ? 'Traefik config + TLS' : 'Traefik backends');
  return [R('backendsUp'),R('backendsTotal'),R('servicesTotal'),R('routersTotal'),R('retries'),R('backendErrors5xx'),R('backendLatencyMsAvg'),R('backendRequests'),spare(),R('httpOpenConnections'),spare(),spare(),R('configReloads'),R('configLastReloadAgeSeconds'),R('tlsCertSoonestExpiryDays'),spare(),spare(),spare(),spare()];
}
function proxyRow(){ return PROXY.map(n => n ? sl(L('proxy', n), 'ProxySQL') : spare()); }
function databaseRow(){
  const out = [];
  ['postgres','mysql','mariadb'].forEach(e => {
    const E = {postgres:'Postgres',mysql:'MySQL',mariadb:'MariaDB'}[e];
    ['InstancesRunning','InstancesHealthy','ConnectionsUsed','ConnectionsMax'].forEach(k => {
      const s = sl(L('storage', e + k), E + ' census', {nw:true});
      out.push(e === 'postgres' ? s : nul(s, 'No managed ' + E + ' on this host.'));
    });
  });
  return fill(out);
}
function pages(list, per, build){
  const out = [];
  for (let i = 0; i < list.length; i += per){
    const chunk = list.slice(i, i + per), slots = [];
    chunk.forEach(x => slots.push(...build(x)));
    out.push({chunk, slots: fill(slots), page: i / per});
  }
  return out;
}
const pageExtra = p => ({page: p.page, ids: p.chunk.join(',')});

/* ---------- Plans (ladder.ts:75-83 + capability-plan.ts) ---------- */
const LADDER = [
  ['S1',2,2,2,9],['S2',2,4,2,9],['S3',5,6,2,9],['S4',5,8,4,9],['S5',8,12,4,18],['S6',8,16,6,18],['S7',11,20,8,18],['SX',11,24,8,18]
];
const TIERS = {today:{}, prop:{}};
LADDER.forEach(([t, nic, drive, gpu, fs]) => {
  const entry = t === 'S1';
  TIERS.today[t] = {nic, drive, gpu, fs: entry ? 0 : fs, sensors: entry ? 11 : 19, docker: !entry};
  TIERS.prop[t] = {nic, drive: Math.ceil(drive / 3) * 3 > 24 ? 24 : Math.ceil(drive / 3) * 3 || 3, gpu: t === 'S1' ? 0 : (t === 'S2' || t === 'S3') ? 1 : gpu, fs: entry ? 1 : fs, sensors: 19, docker: true};
});
const TIER_IDS = LADDER.map(r => r[0]);

/* ---------- Machines ---------- */
const MACHINES = {
  vps: {
    label:'Cloud VPS',
    desc:'A leased VM (DigitalOcean, Hetzner Cloud, Vultr, Linode, Lightsail) or a Proxmox guest in a home lab. Defaults: one virtual disk, one public NIC, no GPU, no sensors. A GPU here means a real passthrough GPU. QEMU\'s virtual display is no longer mistaken for one since turbopaneld #184.',
    cls:'virtual', qemu:false, preset:{nics:1, disks:1, gpus:0, fs:0}
  },
  phys: {
    label:'Physical server',
    desc:'A rented dedicated box (Hetzner AX-class) or a home-lab machine. Defaults: 2 NVMe drives in mdadm RAID1 (Hetzner\'s default), one 1 Gbit NIC, no discrete GPU. Sensors follow the hardware: 6 board and CPU signals, one temperature per drive, and 3 per GPU.',
    cls:'physical', qemu:false, preset:{nics:1, disks:2, gpus:0, fs:0}
  }
};
const LIMITS = {nics:[1,16], disks:[1,30], gpus:[0,10], fs:[0,24]};
/* Build the concrete machine from the preset class + the hardware counters. */
function buildMachine(prof, hw){
  const base = MACHINES[prof], virt = base.cls === 'virtual';
  const nics = Array.from({length: hw.nics}, (_, i) => virt ? 'eth' + i : 'enp' + (5 + i) + 's0');
  const disks = Array.from({length: hw.disks}, (_, i) => virt ? 'vd' + String.fromCharCode(97 + (i % 26)) + (i >= 26 ? i : '') : 'nvme' + i + 'n1');
  const gpus = Array.from({length: hw.gpus}, (_, i) => 'gpu' + i);
  const fs = Array.from({length: hw.fs}, (_, i) => '/mnt/data' + (i + 1));
  let sensors = [];
  if (!virt){
    sensors = [
      ['cpu.package','CPU package temperature (coretemp / k10temp).'],
      ['cpu.hottest-core','Synthetic: hottest CPU core.'],
      ['cpu.throttled','Synthetic: CPU thermal-throttle flag.','flag'],
      ['cpu.power','CPU package power (RAPL; needs root).','W'],
      ['board','Board temperature, where the board exposes one.'],
      ['chipset','Chipset temperature, where exposed.'],
      ...disks.map(d => [d, 'Drive temperature for ' + d + ': the NVMe Composite (or drivetemp) reading, one per drive.']),
      ...gpus.flatMap(g => [[g + ':temp','GPU temperature.'],[g + ':memtemp','GPU memory temperature.'],[g + ':power','GPU power.','W']])
    ];
  }
  return Object.assign({}, base, {nics, disks, gpus, fs, sensors, raid: !virt && hw.disks >= 2});
}

/* ---------- Row model ---------- */
function rowsFor(m, tier, lay, o){
  if (lay === 'prop' || lay === 'custom') return customRows(m, tier, o);
  const t = TIERS[lay][tier], v7 = lay === 'prop', R = [];
  const add = (fam, why, slots, extra) => R.push(Object.assign({fam, why, slots}, extra || {}));
  add('host.system', v7 ? 'Every sample. The liveness anchor. CPU, then memory (incl. OOM kills), then the PID limit.' : 'Every sample. The liveness anchor.', hostSystem(v7));
  add('host.io', v7 ? 'Every sample. Regrouped: disk I/O (incl. new root-disk queue depth and ops/s), root filesystem, network with NICs 1-2, then kernel limits.' : 'Every sample. NICs 1 and 2 are embedded here. Slot order is v6 as shipped.', hostIo(m, v7));
  if (!v7){
    add('host.diagnostics', 'Every sample. Ungated.', DIAG.map(n => sl(L('diagnostics', n), F['diagnostics.' + n].cat === 'C' ? 'CPU detail' : 'Memory detail')));
    add('managed.storage', 'Every sample once the directory walker has run; values change every 15 min. Ungated.', storageRow(m, o));
    if (o.docker && t.docker) add('managed.docker', 'S2 and up, when Docker runs. df is read every 5 min and re-sent each minute.', dockerRow());
  } else {
    add('host.footprint', 'Every sample. Replaces managed.storage, managed.docker and host.diagnostics.', footprint(m, o), {nw:true});
  }
  add('managed.ingress', v7 ? 'Every host: hosting Caddy always runs. Now also carries Traefik\'s backend health and TLS expiry.' : 'Every host: hosting Caddy always runs.', ingressRow(v7, o));
  if (!v7 && o.docker) add('managed.router', 'When Docker runs: the shared Traefik behind Caddy.', routerRow());
  const nicKept = m.nics.slice(0, t.nic);
  pages(nicKept.slice(2), 3, n => many('network',['receiveBytesPerSecond','transmitBytesPerSecond','receiveErrorsPerSecond','transmitErrorsPerSecond','receiveDropsPerSecond','transmitDropsPerSecond'],'NIC ' + n))
    .forEach(p => add('network', 'NICs beyond the first two, 3 per page: ' + p.chunk.join(', ') + '.', p.slots, pageExtra(p)));
  pages(m.fs.slice(0, t.fs), 9, f => many('filesystem',['availableBytes','freeInodes'],'fs ' + f))
    .forEach(p => add('filesystem', 'Extra (non-root) filesystems, 9 per page: ' + p.chunk.join(', ') + '.', p.slots, pageExtra(p)));
  const gpuOk = !v7 || m.cls === 'physical' || o.passthrough;
  if (gpuOk) pages(m.gpus.slice(0, t.gpu), 3, g => many('gpu',['utilizationPercent','memoryUsedBytes','memoryActivityPercent','pcieReceiveBytesPerSecond','pcieTransmitBytesPerSecond','throttlePercent'],'GPU ' + g))
    .forEach(p => add('gpu', 'GPUs, 3 per page: ' + p.chunk.join(', ') + '.', p.slots, pageExtra(p)));
  const disks = m.disks.slice(0, t.drive);
  if (!v7) pages(disks, 2, d => many('block', BLOCK, 'Drive ' + d)).forEach(p => add('block', 'Drive page ' + (p.page + 1) + ': ' + p.chunk.join(', ') + '.', p.slots, pageExtra(p)));
  else if (m.disks.length > 1) pages(disks, 3, d => many('block', BLOCK7, 'Drive ' + d, {nw:false})).forEach(p => add('block', 'More than one disk, so per-drive rows are written, 3 drives per page (a single-disk host skips this row: host.io already covers its only disk). ' + p.chunk.join(', ') + '.', p.slots.map(s => s.f && s.f.name === 'opsPerSecond' ? Object.assign({}, s, {nw:true}) : s), pageExtra(p)));
  if (m.cls === 'physical'){
    const all = (v7 ? [['cpu.average-mhz','CPU average clock, moved from host.diagnostics as a sensor signal.','MHz',true]] : []).concat(m.sensors);
    const kept = all.slice(0, t.sensors);
    const dropped = all.length - kept.length;
    const sig7 = kept.map(([id, d, u, isNew]) => sl(sig(id, d, u, isNew), 'Sensor ' + id, isNew ? {nw:true} : {}));
    add('hardware.physical', 'Physical machines only: ' + all.length + ' signals, ' + (dropped > 0 ? dropped + ' dropped by the plan cap of ' + t.sensors + '. ' : 'all kept. ') + 'One temperature per drive; fans are reported as fault events, not values.', fill(sig7), {ids: kept.map(k => k[0]).join(',')});
  }
  if (o.db){
    if (v7) add('managed.database', 'Only when a managed engine runs. Holds the census that today sits in managed.storage.', databaseRow(), {nw:true});
    add('managed.database_proxy', 'One per ProxySQL source, when managed databases run.', proxyRow());
  }
  if (!v7 && m.qemu && m.gpus.length === 0){
    add('gpu', 'Bug: QEMU\'s virtual display adapter is counted as a GPU (seen on io, megaclite, themisto). Allowed because S1–S3 grant 2 GPU slots whatever the machine class.', fill(many('gpu',['utilizationPercent','memoryUsedBytes','memoryActivityPercent','pcieReceiveBytesPerSecond','pcieTransmitBytesPerSecond','throttlePercent'],'bochs-drm').map(s => nul(s,'The virtual display reports nothing.'))), {bug:true});
    add('hardware.physical', 'Same bug: null GPU signals make the VM look physical, so it gets a sensor row.', fill(['gpu:temp','gpu:power','gpu:memtemp'].map(id => sl(sig(id,'GPU-derived signal from the virtual display.'), 'Signal ' + id, {st:'null', note:'Always null.'}))), {bug:true});
  }
  const ORDER = ['host.system','host.io','block','filesystem','network','host.diagnostics','managed.storage','host.footprint','managed.docker','managed.ingress','managed.router','managed.database','managed.database_proxy','gpu','hardware.physical'];
  return R.map((r, i) => [r, i]).sort((a, b) => (a[0].bug - b[0].bug) || (ORDER.indexOf(a[0].fam) - ORDER.indexOf(b[0].fam)) || (a[1] - b[1])).map(x => x[0]);
}

/* ---------- Blobs (field-map.ts AE_BLOB_* at turbopanel 902236d) ---------- */
const PAGED = ['gpu','network','filesystem','block','hardware.physical'];
const SOURCED = ['managed.ingress','managed.database_proxy'];
function blobsFor(r, v7){
  if (r.blobs) return r.blobs;
  const B = [];
  const put = (name, letter, val, st, desc, extra) => B.push(Object.assign({name, letter, val, st, desc}, extra || {}));
  const empty = (name, desc) => put(name, '', '', 'empty', desc);
  put('kind','k','"metrics"','read','Row kind: metrics, event or status. Every reader filters on it.');
  put('family','f','"' + r.fam + '"','read','The row family. Readers select rows by it.');
  put('schema version','v', v7 ? '"7"' : '"6"','read','Schema version. Readers keep only supported versions (blob3 IN [...]).', v7 ? {nw:true} : {});
  empty('reserved','Always empty since v6 (v5 stored the collection mode here). Held so later blobs keep their numbers.');
  put('sampledAt','t','ISO time','' + (v7 ? 'read' : 'unread'), v7 ? 'The daemon\'s sample time. v7 reads it so AE and DuckDB bucket by the same clock (AE\'s own timestamp is ingest time and cannot be set). No double is free for it, and blobs cost nothing.' : 'The daemon\'s sample time. Written, but no reader uses it: AE buckets by its own ingest timestamp.', v7 ? {nw:true} : {});
  put('sequence','q','"1234"','unread','The sample\'s sequence number. Written, never read. Free to keep for debugging, since blobs cost nothing.');
  put('topology generation','g','"17"','read','Topology generation the sample was built against. Used to map slots to entities.');
  put('plan generation','g','"3"','unread','Capability-plan generation used at ingest. Written, never read.');
  const paged = PAGED.includes(r.fam);
  put('page','p', paged ? '"' + (r.page || 0) + '"' : '"0"', 'unread', 'Page number within a paged family; "0" on single rows. Written, never read: entity ids identify the page.');
  if (paged) put('entity ids','e','"' + (r.ids || 'id1,id2') + '"','read','Comma-joined entity ids, in the same order as the doubles on this page. This is how a reader knows which drive, NIC or sensor each slot belongs to.');
  else if (SOURCED.includes(r.fam)) put('source id','e','"' + (r.fam === 'managed.ingress' ? 'caddy' : 'proxysql') + '"','read','Which Caddy or ProxySQL source the row describes.');
  else empty('entity ids','Empty: this is a host-wide single row with no entity of its own.');
  empty('event entity','Event rows only (the entity an event is about). Empty on metrics rows.');
  empty('event payload','Event rows only (JSON payload). Empty on metrics rows.');
  empty('event id','Event rows only. Empty on metrics rows.');
  [14,15,16].forEach(() => empty('reserved','Reserved, always empty.'));
  empty('reason / severity','Status rows: the transition reason. Event rows: severity. Empty on metrics rows.');
  [18,19,20].forEach(() => empty('reserved','Reserved, always empty.'));
  return B;
}

/* ---------- Custom builder: catalogue, presets, auto-packing ---------- */
const SECTIONS = [
  ['env','Row envelope (blobs on every row)'],['cpu','CPU'],['mem','Memory'],['limits','Kernel limits'],['diskio','Disk I/O'],
  ['space','Disk space'],['net','Network'],['health','Host health and identity'],['dirs','Hosting directories'],['docker','Docker (host-wide)'],
  ['diag','Diagnostics (deep dive)'],['caddy','Caddy'],['traefik','Traefik'],['dbc','Database census'],['proxy','ProxySQL'],
  ['drive','Per drive'],['nic','Per extra NIC (3rd onward)'],['fs','Per extra filesystem'],['gpu','Per GPU'],['sensor','Sensors (physical)']
];
const ENTITY_SECS = ['drive','nic','fs','gpu','sensor'];
/* id|section|pool|kind(d/b)|ref or -|name|unit|agg|cat|src|presets|desc|req|width
   presets: v = v6 today, l = lean, b = balanced, x = balanced + text blobs (every item is in "everything") */
const RAW = `
kind|env|-|b|-|kind|text|-|E|v6|vlbx|Row kind: metrics, event or status. Required.|lock|
family|env|-|b|-|family / row name|text|-|E|v6|vlbx|Which row this is. Required.|lock|
version|env|-|b|-|schema version|text|-|E|v6|vlbx|Schema version readers filter on. Required.|lock|
sampledAt|env|-|b|-|sample time|text|-|E|v6|vlbx|The daemon's ISO sample time (readable for AE/DuckDB clock parity).||
sequence|env|-|b|-|sequence|text|-|E|v6|vlbx|Sample sequence number. Never read today; handy for debugging.||
topoGen|env|-|b|-|topology generation|text|-|E|v6|vlbx|Maps slots to entities.||
planGen|env|-|b|-|plan generation|text|-|E|v6|vlbx|Capability-plan generation. Never read today.||
page|env|-|b|-|page|text|-|E|v6|vlbx|Page number on paged rows. Never read today.||
ids|env|-|b|-|entity / source ids|text|-|E|v6|vlbx|Which drive, NIC, sensor or source each slot belongs to. Required on entity rows.|lock|
busy|cpu|core|d|host.cpu.busyPercent|||||v6|vlbx|||
user|cpu|core|d|host.cpu.userPercent|||||v6|vlbx|||
system|cpu|core|d|host.cpu.systemPercent|||||v6|vlbx|||
iowait|cpu|core|d|host.cpu.iowaitPercent|||||v6|vlbx|||
steal|cpu|core|d|host.cpu.stealPercent|||||v6|vlbx|||
softirq|cpu|core|d|host.cpu.softirqPercent|||||v6|vlbx|||
cpuPsi|cpu|core|d|host.cpu.pressureSomePercent|||||v6|vlbx|||
saturated|cpu|core|d|host.cpu.saturatedCoreCount|||||v6|vlbx|||
procsRunning|cpu|core|d|host.cpu.procsRunning|||||v6|vlbx|||
procsBlocked|cpu|core|d|host.cpu.procsBlocked|||||v6|vbx|||
processCount|cpu|core|d|host.cpu.processCount|||||v6|vbx|||
loadavg|cpu|core|b|-|load average (text)|text|-|C|idea|x|Raw /proc/loadavg line, e.g. "0.52 0.61 0.70 2/431 12345": 1/5/15-minute load, runnable/total tasks, last PID. A quick snapshot without using doubles.||
topCpu|cpu|core|b|-|top CPU process|text|-|C|idea|x|Short name of the busiest process (never the full command line, which can hold secrets).||
cpuModel|cpu|core|b|-|CPU model|text|-|C|idea||CPU model string. Changes only on hardware moves.||
used|mem|core|d|host.memory.usedBytes|||||v6|vlbx|||
cachedFiles|mem|core|d|host.memory.cachedFilesBytes|||||v6|vlbx|||
swapUsed|mem|core|d|host.memory.swapUsedBytes|||||v6|vlbx|||
memPsiSome|mem|core|d|host.memory.pressureSomePercent|||||v6|vlbx|||
memPsiFull|mem|core|d|host.memory.pressureFullPercent|||||v6|vlbx|||
swapIn|mem|core|d|host.memory.swapInBytesPerSecond|||||v6|vlbx|||
swapOut|mem|core|d|host.memory.swapOutBytesPerSecond|||||v6|vlbx|||
majorFaults|mem|core|d|host.memory.majorPageFaultsPerSecond|||||v6|vlbx|||
oomKills|mem|core|d|host.memory.oomKills|||||new|lbx|||
topMem|mem|core|b|-|top memory process|text|-|M|idea|x|Short name of the process using the most memory.||
lastOom|mem|core|b|-|last OOM victim|text|-|M|idea|x|Name of the last process the kernel OOM killer ended, and when, e.g. "php-fpm8.3 16:02Z".||
fileHandles|limits|io|d|host.kernel.fileHandlesUsedPercent|||||v6|vlbx|||
conntrack|limits|io|d|host.kernel.conntrackUsedPercent|||||v6|vlbx|||
pidLimit|limits|core|d|host.cpu.pidLimitUsedPercent|||||new|lbx|||
ioPsiSome|diskio|io|d|host.storage.ioPressureSomePercent|||||v6|vlbx|||
ioPsiFull|diskio|io|d|host.storage.ioPressureFullPercent|||||v6|vlbx|||
diskRead|diskio|io|d|host.storage.diskReadBytesPerSecond|||||v6|vlbx|||
diskWrite|diskio|io|d|host.storage.diskWriteBytesPerSecond|||||v6|vlbx|||
diskLatency|diskio|io|d|host.storage.diskLatencyMs|||||v6|vlbx|||
rootQueue|diskio|io|d|host.io.rootDiskQueueDepth|||||new|lbx|||
rootOps|diskio|io|d|host.io.rootDiskOpsPerSecond|||||new|lbx|||
rootAvail|space|io|d|host.storage.rootFilesystemAvailableBytes|||||v6|vlbx|||
rootInodes|space|io|d|host.storage.rootFilesystemFreeInodes|||||v6|vlbx|||
tcpRetrans|net|io|d|host.network.tcpRetransmitPercent|||||v6|vlbx|||
softnet|net|io|d|host.network.softnetDropsPerSecond|||||v6|vlbx|||
nic1|net|io|d|-|NIC 1 rx / tx / problems|B/s|avg|N|v6|vlbx|First NIC embedded in the host row: receive, transmit, errors+drops. Saves a NIC row on 1-2 NIC hosts.|nic1|3
nic2|net|io|d|-|NIC 2 rx / tx / problems|B/s|avg|N|v6|vlbx|Second NIC embedded in the host row.|nic2|3
systemdFailed|health|footprint|d|health.systemdUnitsFailed|||||new|lbx|||
mdDegraded|health|footprint|d|health.mdArraysDegraded|||||new|lbx||raid|
mdResync|health|footprint|d|health.mdArraysResyncing|||||new|lbx||raid|
failedUnits|health|footprint|b|-|failed unit names|text|-|H|idea|x|Comma-joined names of failed systemd units, e.g. "php8.3-fpm.service".||
raidState|health|footprint|b|-|RAID state|text|-|H|idea|x|/proc/mdstat summary, e.g. "md0 [UU] idle" or "[U_] recover 41%".|raid|
rebootRequired|health|footprint|b|-|reboot required|text|-|H|idea|x|Whether a reboot is pending, and why (kernel or library updates).||
kernel|health|footprint|b|-|kernel release|text|-|H|idea|x|uname -r. Changes on reboot after kernel updates.||
os|health|footprint|b|-|OS release|text|-|H|idea|x|PRETTY_NAME from /etc/os-release.||
bootId|health|footprint|b|-|boot id|text|-|H|idea|x|Changes on every reboot, so reboots are exact.||
virt|health|footprint|b|-|virtualisation|text|-|H|idea||systemd-detect-virt result: kvm, lxc, none…||
cloudProvider|health|footprint|b|-|cloud provider|text|-|H|idea|x|From the DMI vendor (DigitalOcean, Hetzner, QEMU, Dell…). Cheap, changes only on migration.||
agentVersion|health|footprint|b|-|TurboPanel daemon version|text|-|H|idea|x|turbopaneld version, to spot hosts on old agents.||
timeSync|health|footprint|b|-|clock sync|text|-|H|idea|x|Whether NTP/timesyncd reports the clock as synced. A drifting clock breaks TLS and logs.||
pendingUpdates|health|footprint|b|-|pending updates|text|-|H|idea|x|Package updates waiting, e.g. "12 (3 security)". Refreshed hourly at most.||
fsReadOnly|health|footprint|b|-|read-only filesystems|text|-|H|idea|x|Any filesystem the kernel remounted read-only after errors, e.g. "/var/www". Empty when healthy. Usually a dying disk.||
phpVersions|health|footprint|b|-|PHP versions|text|-|H|idea|x|PHP versions in use across sites, e.g. "8.2, 8.3". For classic hosting.||
webEngines|health|footprint|b|-|web engine versions|text|-|H|idea|x|Installed nginx / Apache / OpenLiteSpeed versions.||
fpmBusiest|health|footprint|b|-|busiest PHP pool|text|-|H|idea|x|The php-fpm or lsphp pool closest to its worker limit, as site id and busy/max, e.g. "site42 18/20". Covers service health on hosts without Docker. New collection (pool status page).||
hostingUsed|dirs|footprint|d|storage.hostingUsedBytes|||||v6|vlbx|||
backupUsed|dirs|footprint|d|storage.backupUsedBytes|||||v6|vlbx|||
dockerUsed|dirs|footprint|d|storage.dockerUsedBytes|||||v6|vlbx||docker|
logsUsed|dirs|footprint|d|storage.logsUsedBytes|||||v6|vlbx|||
hostingFree|dirs|footprint|d|storage.hostingFreeBytes|||||v6|vlbx|||
backupFree|dirs|footprint|d|storage.backupFreeBytes|||||v6|vlbx|||
logsFree|dirs|footprint|d|storage.logsFreeBytes|||||v6|vlbx|||
topSites|dirs|footprint|b|-|largest sites|text|-|S|idea|x|Top 5 sites by disk use, as site ids with sizes (never domain names), from the same 15-minute directory walk. Most useful on traditional shared hosting.||
ctrRunning|docker|footprint|d|docker.containersRunning|||||new|lbx||docker|
ctrUnhealthy|docker|footprint|d|docker.containersUnhealthy|||||new|lbx||docker|
ctrRestarting|docker|footprint|d|docker.containersRestarting|||||new|lbx||docker|
ctrOom|docker|footprint|d|docker.containerOomEvents|||||new|lbx||docker|
ctrDie|docker|footprint|d|docker.containerDieEvents|||||new|lbx||docker|
ctrCpu|docker|footprint|d|-|containers CPU %|%|avg|D|idea|bx|CPU used by all containers together, as a share of the host (sum of container cgroups). Verify the collection path.|docker|
ctrMem|docker|footprint|d|-|containers memory|bytes|avg|D|idea|bx|Memory used by all containers together.|docker|
ctrNetRx|docker|footprint|d|-|containers net in|B/s|avg|D|idea|bx|Network received by all containers.|docker|
ctrNetTx|docker|footprint|d|-|containers net out|B/s|avg|D|idea|bx|Network sent by all containers.|docker|
ctrBlkRead|docker|footprint|d|-|containers disk read|B/s|avg|D|idea|bx|Disk reads by all containers.|docker|
ctrBlkWrite|docker|footprint|d|-|containers disk write|B/s|avg|D|idea|bx|Disk writes by all containers.|docker|
layers|docker|footprint|d|docker.layersBytes|||||v6|vlbx||docker|
imagesCount|docker|footprint|d|docker.imagesCount|||||v6|vbx||docker|
imagesRecl|docker|footprint|d|docker.imagesReclaimableBytes|||||v6|vbx||docker|
ctrBytes|docker|footprint|d|docker.containersBytes|||||v6|vbx||docker|
ctrCount|docker|footprint|d|docker.containersCount|||||v6|vbx||docker|
volumes|docker|footprint|d|docker.volumesBytes|||||v6|vlbx||docker|
volumesCount|docker|footprint|d|docker.volumesCount|||||v6|vbx||docker|
volumesRecl|docker|footprint|d|docker.volumesReclaimableBytes|||||v6|vbx||docker|
buildCache|docker|footprint|d|docker.buildCacheBytes|||||v6|vlbx||docker|
buildCacheRecl|docker|footprint|d|docker.buildCacheReclaimableBytes|||||v6|vbx||docker|
reclTotal|docker|footprint|d|docker.reclaimableBytes|||||new|l||docker|
unhealthyNames|docker|footprint|b|-|unhealthy containers|text|-|D|idea|x|Names of containers whose healthcheck fails.|docker|
dockerVersion|docker|footprint|b|-|Docker version|text|-|D|idea|x|Docker Engine and Compose versions.|docker|
cgroupVer|docker|footprint|b|-|cgroup version|text|-|D|idea||cgroup v1 or v2 (affects container stats).|docker|
dMhzAvg|diag|diag|d|diagnostics.averageFrequencyMHz|||||v6|vbx|||
dMhzMin|diag|diag|d|diagnostics.minimumFrequencyMHz|||||v6|vbx|||
dMhzMax|diag|diag|d|diagnostics.maximumFrequencyMHz|||||v6|vbx|||
dCtx|diag|diag|d|diagnostics.contextSwitchesPerSecond|||||v6|vbx|||
dIrqs|diag|diag|d|diagnostics.interruptsPerSecond|||||v6|vbx|||
dForks|diag|diag|d|diagnostics.forksPerSecond|||||v6|vbx|||
dIrqPct|diag|diag|d|diagnostics.cpuIrqPercent|||||v6|vbx|||
dFree|diag|diag|d|diagnostics.memoryFreeBytes|||||v6|vbx|||
dCached|diag|diag|d|diagnostics.cachedBytes|||||v6|vbx|||
dAnon|diag|diag|d|diagnostics.anonPagesBytes|||||v6|vbx|||
dSlabR|diag|diag|d|diagnostics.slabReclaimableBytes|||||v6|vbx|||
dSlabU|diag|diag|d|diagnostics.slabUnreclaimableBytes|||||v6|vbx|||
dDirty|diag|diag|d|diagnostics.dirtyBytes|||||v6|vbx|||
dWb|diag|diag|d|diagnostics.writebackBytes|||||v6|vbx|||
dShmem|diag|diag|d|diagnostics.shmemBytes|||||v6|vbx|||
dCommit|diag|diag|d|diagnostics.committedAsBytes|||||v6|vbx|||
dScanD|diag|diag|d|diagnostics.pageScanDirectPerSecond|||||v6|vbx|||
dScanK|diag|diag|d|diagnostics.pageScanKswapdPerSecond|||||v6|vbx|||
dCompact|diag|diag|d|diagnostics.compactionStallsPerSecond|||||v6|vbx|||
cReq|caddy|caddy|d|ingress.requests|||||v6|vlbx|||
c2xx|caddy|caddy|d|ingress.responses2xx|||||v6|vlbx|||
c3xx|caddy|caddy|d|ingress.responses3xx|||||v6|vlbx|||
c4xx|caddy|caddy|d|ingress.responses4xx|||||v6|vlbx|||
c5xx|caddy|caddy|d|ingress.responses5xx|||||v6|vlbx|||
cErr|caddy|caddy|d|ingress.requestErrors|||||v6|vlbx|||
cReqB|caddy|caddy|d|ingress.requestBytes|||||v6|vlbx|||
cRespB|caddy|caddy|d|ingress.responseBytes|||||v6|vlbx|||
cDur|caddy|caddy|d|ingress.requestDurationSecondsSum|||||v6|vlbx|||
cB10|caddy|caddy|d|ingress.bucket10ms|||||v6|vlbx|||
cB50|caddy|caddy|d|ingress.bucket50ms|||||v6|vlbx|||
cB100|caddy|caddy|d|ingress.bucket100ms|||||v6|vlbx|||
cB500|caddy|caddy|d|ingress.bucket500ms|||||v6|vlbx|||
cB1s|caddy|caddy|d|ingress.bucket1s|||||v6|vlbx|||
cB5s|caddy|caddy|d|ingress.bucket5s|||||v6|vlbx|||
cInFlight|caddy|caddy|d|ingress.requestsInFlight|||||v6|vlbx|||
cUpHealthy|caddy|caddy|d|ingress.upstreamsHealthy|||||v6|v|||
cUpTotal|caddy|caddy|d|ingress.upstreamsTotal|||||v6|v|||
cRetries|caddy|caddy|d|ingress.retries|||||v6|v|||
cTls|caddy|caddy|d|ingress.tlsCertSoonestExpiryDays|||||new|lbx|||
caddyVersion|caddy|caddy|b|-|Caddy version|text|-|W|idea|x|Hosting Caddy's version.||
topSitesReq|caddy|caddy|b|-|top sites by requests|text|-|W|idea|x|The 5 busiest sites this minute, as site ids with request counts. Needs Caddy per-host metrics.||
topSites5xx|caddy|caddy|b|-|top sites by 5xx|text|-|W|idea|x|The 5 sites with the most 5xx errors this minute (site ids). Points straight at a broken site.||
certSoonest|caddy|caddy|b|-|soonest-expiring certificate|text|-|W|idea|x|Site id and days left for the certificate closest to expiry; the TLS-expiry number says how soon, this says which.||
tUp|traefik|traefik|d|router.backendsUp|||||v6|vlbx||docker|
tTotal|traefik|traefik|d|router.backendsTotal|||||v6|vlbx||docker|
tServices|traefik|traefik|d|router.servicesTotal|||||v6|vbx||docker|
tRouters|traefik|traefik|d|router.routersTotal|||||v6|vbx||docker|
tRetries|traefik|traefik|d|router.retries|||||v6|vbx||docker|
t5xx|traefik|traefik|d|router.backendErrors5xx|||||v6|vbx||docker|
tLatency|traefik|traefik|d|router.backendLatencyMsAvg|||||v6|vbx||docker|
tRequests|traefik|traefik|d|router.backendRequests|||||v6|vbx||docker|
tConns|traefik|traefik|d|router.httpOpenConnections|||||v6|vbx||docker|
tReloads|traefik|traefik|d|router.configReloads|||||v6|vbx||docker|
tReloadAge|traefik|traefik|d|router.configLastReloadAgeSeconds|||||v6|vbx||docker|
tTls|traefik|traefik|d|router.tlsCertSoonestExpiryDays|||||v6|v||docker|
traefikVersion|traefik|traefik|b|-|Traefik version|text|-|W|idea|x|Shared Traefik's version.|docker|
unhealthyBackends|traefik|traefik|b|-|unhealthy backends|text|-|W|idea|x|Traefik services with no healthy backend, by service id.|docker|
dbpostgresInstancesRunning|dbc|database|d|storage.postgresInstancesRunning|||||v6|vlbx||db:postgres|
dbpostgresInstancesHealthy|dbc|database|d|storage.postgresInstancesHealthy|||||v6|vlbx||db:postgres|
dbpostgresConnectionsUsed|dbc|database|d|storage.postgresConnectionsUsed|||||v6|vlbx||db:postgres|
dbpostgresConnectionsMax|dbc|database|d|storage.postgresConnectionsMax|||||v6|vlbx||db:postgres|
dbmysqlInstancesRunning|dbc|database|d|storage.mysqlInstancesRunning|||||v6|vlbx||db:mysql|
dbmysqlInstancesHealthy|dbc|database|d|storage.mysqlInstancesHealthy|||||v6|vlbx||db:mysql|
dbmysqlConnectionsUsed|dbc|database|d|storage.mysqlConnectionsUsed|||||v6|vlbx||db:mysql|
dbmysqlConnectionsMax|dbc|database|d|storage.mysqlConnectionsMax|||||v6|vlbx||db:mysql|
dbmariadbInstancesRunning|dbc|database|d|storage.mariadbInstancesRunning|||||v6|vlbx||db:mariadb|
dbmariadbInstancesHealthy|dbc|database|d|storage.mariadbInstancesHealthy|||||v6|vlbx||db:mariadb|
dbmariadbConnectionsUsed|dbc|database|d|storage.mariadbConnectionsUsed|||||v6|vlbx||db:mariadb|
dbmariadbConnectionsMax|dbc|database|d|storage.mariadbConnectionsMax|||||v6|vlbx||db:mariadb|
pxqueries|proxy|proxy|d|proxy.queries|||||v6|vlbx||db|
pxslowQueries|proxy|proxy|d|proxy.slowQueries|||||v6|vlbx||db|
pxqueryLatencyMsAvg|proxy|proxy|d|proxy.queryLatencyMsAvg|||||v6|vlbx||db|
pxbackendLatencyMsAvg|proxy|proxy|d|proxy.backendLatencyMsAvg|||||v6|vlbx||db|
pxactiveTransactions|proxy|proxy|d|proxy.activeTransactions|||||v6|vlbx||db|
pxclientConnections|proxy|proxy|d|proxy.clientConnections|||||v6|vlbx||db|
pxclientConnectionsCreated|proxy|proxy|d|proxy.clientConnectionsCreated|||||v6|vlbx||db|
pxclientConnectionsAborted|proxy|proxy|d|proxy.clientConnectionsAborted|||||v6|vlbx||db|
pxconnectionsRejectedMaxConns|proxy|proxy|d|proxy.connectionsRejectedMaxConns|||||v6|vlbx||db|
pxbackendConnections|proxy|proxy|d|proxy.backendConnections|||||v6|vlbx||db|
pxbackendConnectionsCreated|proxy|proxy|d|proxy.backendConnectionsCreated|||||v6|vlbx||db|
pxbackendConnectionsAborted|proxy|proxy|d|proxy.backendConnectionsAborted|||||v6|vlbx||db|
pxconnectionErrors|proxy|proxy|d|proxy.connectionErrors|||||v6|vlbx||db|
pxbackendsUp|proxy|proxy|d|proxy.backendsUp|||||v6|vlbx||db|
pxbackendsTotal|proxy|proxy|d|proxy.backendsTotal|||||v6|vlbx||db|
pxbytesFromBackends|proxy|proxy|d|proxy.bytesFromBackends|||||v6|vlbx||db|
pxbytesToBackends|proxy|proxy|d|proxy.bytesToBackends|||||v6|vlbx||db|
dbVersions|dbc|database|b|-|engine versions|text|-|B|idea|x|Versions of the managed engines on this host.|db|
dr_readBytesPerSecond|drive|drive|d|block.readBytesPerSecond|||||v6|vlbx|||
dr_writeBytesPerSecond|drive|drive|d|block.writeBytesPerSecond|||||v6|vlbx|||
dr_readOpsPerSecond|drive|drive|d|block.readOpsPerSecond|||||v6|v|||
dr_writeOpsPerSecond|drive|drive|d|block.writeOpsPerSecond|||||v6|v|||
dr_opsPerSecond|drive|drive|d|block.opsPerSecond|||||new|lbx|||
dr_readLatencyMs|drive|drive|d|block.readLatencyMs|||||v6|vlbx|||
dr_writeLatencyMs|drive|drive|d|block.writeLatencyMs|||||v6|vlbx|||
dr_utilizationPercent|drive|drive|d|block.utilizationPercent|||||v6|v|||
dr_queueDepth|drive|drive|d|block.queueDepth|||||v6|vlbx|||
dr_model|drive|drive|b|-|drive model / firmware|text|-|I|idea|x|Model and firmware of each drive on the row.||
dr_smart|drive|drive|b|-|SMART result|text|-|I|idea||PASSED / FAILED per drive (better as an hourly event).||
nc_receiveBytesPerSecond|nic|nic|d|network.receiveBytesPerSecond|||||v6|vlbx|||
nc_transmitBytesPerSecond|nic|nic|d|network.transmitBytesPerSecond|||||v6|vlbx|||
nc_receiveErrorsPerSecond|nic|nic|d|network.receiveErrorsPerSecond|||||v6|vlbx|||
nc_transmitErrorsPerSecond|nic|nic|d|network.transmitErrorsPerSecond|||||v6|vlbx|||
nc_receiveDropsPerSecond|nic|nic|d|network.receiveDropsPerSecond|||||v6|vlbx|||
nc_transmitDropsPerSecond|nic|nic|d|network.transmitDropsPerSecond|||||v6|vlbx|||
nc_link|nic|nic|b|-|link state|text|-|N|idea|x|Per NIC: up/down and speed, e.g. "up 1000Mb/s".||
fs_availableBytes|fs|fs|d|filesystem.availableBytes|||||v6|vlbx|||
fs_freeInodes|fs|fs|d|filesystem.freeInodes|||||v6|vlbx|||
fs_totalBytes|fs|fs|d|filesystem.totalBytes|||||new|||||
fs_totalInodes|fs|fs|d|filesystem.totalInodes|||||new|||||
fs_type|fs|fs|b|-|filesystem type / mount|text|-|S|idea||Per filesystem: type and mount point, e.g. "ext4 /mnt/data".||
gp_utilizationPercent|gpu|gpu|d|gpu.utilizationPercent|||||v6|vlbx|||
gp_memoryUsedBytes|gpu|gpu|d|gpu.memoryUsedBytes|||||v6|vlbx|||
gp_memoryActivityPercent|gpu|gpu|d|gpu.memoryActivityPercent|||||v6|vlbx|||
gp_pcieReceiveBytesPerSecond|gpu|gpu|d|gpu.pcieReceiveBytesPerSecond|||||v6|vlbx|||
gp_pcieTransmitBytesPerSecond|gpu|gpu|d|gpu.pcieTransmitBytesPerSecond|||||v6|vlbx|||
gp_throttlePercent|gpu|gpu|d|gpu.throttlePercent|||||v6|vlbx|||
gp_memoryTotalBytes|gpu|gpu|d|gpu.memoryTotalBytes|||||new|||||
gp_driver|gpu|gpu|b|-|GPU driver version|text|-|G|idea|x|Per GPU driver version (e.g. nvidia 570.x).||
gp_model|gpu|gpu|b|-|GPU model|text|-|G|idea|x|Per GPU model name.||
memTotal|mem|core|d|extended.sizes.memoryTotalBytes|||||new|||||
swapTotal|mem|core|d|extended.sizes.swapTotalBytes|||||new|||||
commitLimit|mem|core|d|extended.sizes.commitLimitBytes|||||new|||||
cores|cpu|core|d|extended.sizes.logicalCores|||||new|||||
rootTotal|space|io|d|extended.sizes.rootFilesystemTotalBytes|||||new|||||
rootInodesTotal|space|io|d|extended.sizes.rootFilesystemTotalInodes|||||new|||||
sn_value|sensor|sensor|d|-|sensor reading|value|avg|T|v6|vlbx|One value per sensor signal (temperatures, power, one per drive). Kinds come from topology.||
`;
const ITEMS = RAW.trim().split('\n').map(line => {
  const [id, sec, pool, kind, ref, name, unit, agg, cat, src, presets, desc, req, width] = line.split('|');
  let f;
  if (ref && ref !== '-'){
    const base = F[ref]; if (!base) throw new Error('missing field ' + ref);
    f = base;
  } else {
    f = {name, unit, agg, cat, desc, scope: sec};
  }
  return {id, sec, pool, kind, f, src, presets: presets || '', req: req || '', w: +width || 1, lock: req === 'lock'};
});
const ITEM = Object.fromEntries(ITEMS.map(i => [i.id, i]));
const ENV_LETTER = {kind:'k', family:'f', version:'v', sampledAt:'t', sequence:'q', topoGen:'g', planGen:'g', page:'p', ids:'e'};
const REC_IDS = 'kind family version sampledAt topoGen ids busy user system iowait steal softirq cpuPsi saturated loadavg topCpu used cachedFiles swapUsed memPsiSome memPsiFull majorFaults oomKills topMem fileHandles conntrack pidLimit ioPsiSome ioPsiFull diskRead diskWrite diskLatency rootQueue rootOps rootAvail rootInodes tcpRetrans nic1 nic2 systemdFailed mdDegraded failedUnits raidState rebootRequired kernel os bootId hostingUsed backupUsed dockerUsed logsUsed ctrRunning ctrUnhealthy ctrRestarting ctrOom ctrDie ctrCpu ctrMem reclTotal unhealthyNames dockerVersion dCommit dSlabU cReq c2xx c4xx c5xx cErr cReqB cRespB cDur cB100 cB500 cB1s cInFlight cTls caddyVersion tUp tTotal tRequests t5xx tLatency traefikVersion dbpostgresInstancesRunning dbpostgresInstancesHealthy dbmysqlInstancesRunning dbmysqlInstancesHealthy dbmariadbInstancesRunning dbmariadbInstancesHealthy dbVersions pxqueries pxslowQueries pxqueryLatencyMsAvg pxbackendLatencyMsAvg pxactiveTransactions pxclientConnections pxclientConnectionsAborted pxconnectionsRejectedMaxConns pxbackendConnections pxconnectionErrors pxbackendsUp pxbackendsTotal dr_readBytesPerSecond dr_writeBytesPerSecond dr_opsPerSecond dr_readLatencyMs dr_writeLatencyMs dr_queueDepth dr_model nc_receiveBytesPerSecond nc_transmitBytesPerSecond nc_receiveErrorsPerSecond nc_transmitErrorsPerSecond nc_receiveDropsPerSecond nc_transmitDropsPerSecond nc_link fs_availableBytes fs_freeInodes gp_utilizationPercent gp_memoryUsedBytes gp_memoryActivityPercent gp_pcieReceiveBytesPerSecond gp_pcieTransmitBytesPerSecond gp_throttlePercent gp_driver gp_model sn_value hostingFree backupFree layers volumes buildCache ctrBytes topSites lastOom cloudProvider agentVersion timeSync pendingUpdates fsReadOnly phpVersions webEngines fpmBusiest topSitesReq topSites5xx certSoonest unhealthyBackends cpuModel virt dr_smart'.split(' ');
const PRESETS = [
  {id:'r', name:'Recommended', mode:'auto', rules:{skipDrive:true, foldFs:true, foldGpu:false}, ids: REC_IDS,
   blurb:'Claude\'s pick: every signal that drives an alert or a decision, packed into the fewest rows. 4 rows on a VPS, 6 on a 2-drive physical server, +1 with managed databases.'},
  {id:'0', name:'Blank slate', mode:'auto', rules:{skipDrive:true, foldFs:false, foldGpu:false},
   blurb:'Nothing ticked except the three blobs every row needs. Build your own schema from scratch.'},
  {id:'v', name:'v6 today', mode:'auto', rules:{skipDrive:false, foldFs:false, foldGpu:false},
   blurb:'Every field trunk stores now. Packed by this tool, so slot positions differ from the real v6 layout in Now.'},
  {id:'l', name:'Lean', mode:'auto', rules:{skipDrive:true, foldFs:false, foldGpu:false},
   blurb:'The draft v7 plan: alert-backed metrics only, diagnostics to the live view, Traefik reduced to backend health.'},
  {id:'b', name:'Balanced', mode:'auto', rules:{skipDrive:true, foldFs:false, foldGpu:false},
   blurb:'Lean plus what you asked back: the full Traefik row, diagnostics, Docker df counts, process counts, and host-wide container totals.'},
  {id:'x', name:'Balanced + text', mode:'auto', rules:{skipDrive:true, foldFs:false, foldGpu:false},
   blurb:'Balanced, plus useful text in the empty blobs: load average, top processes, failed units, RAID state, versions, kernel, OS, drive and GPU models.'},
  {id:'a', name:'Everything', mode:'auto', rules:{skipDrive:true, foldFs:true, foldGpu:true},
   blurb:'Every field and idea in the catalogue, packed as tightly as possible, with single-entity folding on.'}
];
const MODES = {
  auto:{name:'Smart', desc:'Keeps Docker and database fields in their own rows so hosts without them skip those rows, then packs each group into the fewest rows: biggest sections first, whole sections where possible, and like subjects side by side.', pool: it => it.pool},
  tight:{name:'Tight', desc:'Fill every slot: all host-wide fields share rows; Caddy and Traefik share rows; databases share rows.', pool: it => ({core:'host', io:'host', footprint:'host', diag:'host', caddy:'web', traefik:'web', database:'db', proxy:'db'})[it.pool] || it.pool},
  grouped:{name:'Grouped', desc:'Rows by area: core (CPU, memory), I/O (disk, space, network, limits), footprint (health, directories, Docker), diagnostics, Caddy, Traefik, databases.', pool: it => it.pool},
  subject:{name:'One subject per row', desc:'Every section gets its own rows. Easiest to read, most rows.', pool: it => ENTITY_SECS.includes(it.sec) ? it.pool : it.sec}
};
const POOL_NAMES = {host:'host', core:'host.core', io:'host.io', footprint:'host.footprint', diag:'host.diagnostics', caddy:'caddy', traefik:'traefik', web:'web', database:'database', proxy:'proxysql', db:'databases',
  cpu:'cpu', mem:'memory', limits:'limits', diskio:'disk-io', space:'disk-space', net:'network-stack', health:'health', dirs:'directories', docker:'docker', dbc:'database'};
const POOL_ORDER = ['host','core','cpu','mem','limits','io','diskio','space','net','footprint','health','dirs','docker','diag','web','caddy','traefik','db','database','dbc','proxy'];
const SEC_ORDER = SECTIONS.map(s => s[0]);

const builder = {sel: new Set(), mode:'auto', rules:{skipDrive:true, foldFs:false, foldGpu:false}, preset:'b'};
function applyPreset(pid){
  const p = PRESETS.find(x => x.id === pid);
  builder.sel = new Set(ITEMS.filter(i => i.lock || pid === 'a' || (p.ids ? p.ids.includes(i.id) : i.presets.includes(pid))).map(i => i.id));
  builder.mode = p.mode; builder.rules = Object.assign({}, p.rules); builder.preset = pid;
}
applyPreset('r');
function presentOn(it, m, o, eng){
  const r = it.req;
  if (!r || r === 'lock') return true;
  if (r === 'docker') return o.docker;
  if (r === 'db') return o.db;
  if (r.startsWith('db:')) return o.db && r.slice(3) === eng;
  if (r === 'raid') return m.raid;
  if (r === 'nic1') return m.nics.length >= 1;
  if (r === 'nic2') return m.nics.length >= 2;
  return true;
}
function expandDoubles(it, present, label){
  if (it.w === 1) return [Object.assign(sl(it.f, label || SECTIONS.find(s => s[0] === it.sec)[1]), {id: it.id, fold: it.fold || null}, present ? {} : {st:'null', note: absentNote(it)}, it.src !== 'v6' ? {nw:true} : {})];
  const n = it.id === 'nic1' ? 1 : 2;
  return ['rx','tx','problems'].map(k => Object.assign(sl(L('nic', k), 'NIC ' + n), {id: it.id + '.' + k}, present ? {} : {st:'null', note:'No NIC ' + n + ' on this host: null.'}));
}
function absentNote(it){
  const r = it.req;
  if (r === 'docker') return 'No Docker on this host: null.';
  if (r === 'db' || (r || '').startsWith('db:')) return 'Engine not running on this host: null.';
  if (r === 'raid') return 'No software RAID on this host: null.';
  return 'Not present on this host: null.';
}
function blobOf(it, present){
  return {id: it.id, fold: it.fold || null, name: it.f.name, letter: it.f.cat, val: '…', st: present ? 'read' : 'empty', desc: it.f.desc + (present ? '' : ' (not present on this host)'), nw: it.src !== 'v6', content:true};
}
function envBlobs(fam, page, ids){
  return ITEMS.filter(i => i.sec === 'env' && builder.sel.has(i.id)).map(i => {
    const val = i.id === 'family' ? '"' + fam + '"' : i.id === 'version' ? '"7"' : i.id === 'kind' ? '"metrics"' : i.id === 'ids' ? (ids ? '"' + ids + '"' : '""') : i.id === 'page' ? '"' + (page || 0) + '"' : '…';
    return {id: i.id, env: true, name: i.f.name, letter: ENV_LETTER[i.id], val, st: (i.id === 'ids' && !ids) ? 'empty' : 'read', desc: i.f.desc};
  });
}
function finishBlobs(env, content){
  const b = env.concat(content);
  while (b.length < 20) b.push({name:'empty', letter:'', val:'', st:'empty', desc:'Unused blob.'});
  return b.slice(0, 20);
}

/* Pack one pool's selected items into fixed rows. Returns layout rows [{doubles:[{it,slots}], blobs:[it]}] */
function packPool(items, cap){
  const rows = [{d:[], used:0, b:[]}];
  items.filter(i => i.kind === 'd').forEach(it => {
    let r = rows[rows.length - 1];
    if (r.used + it.w > 19){ r = {d:[], used:0, b:[]}; rows.push(r); }
    r.d.push(it); r.used += it.w;
  });
  let ri = 0;
  items.filter(i => i.kind === 'b').forEach(it => {
    while (rows[ri] && rows[ri].b.length >= cap) ri++;
    if (!rows[ri]) rows.push({d:[], used:0, b:[]});
    rows[ri].b.push(it);
  });
  return rows.filter(r => r.d.length || r.b.length);
}

function poolLayout(hostItems, cap, mode){
  const pools = {}, out = [];
  hostItems.forEach(it => { const p = mode.pool(it); (pools[p] = pools[p] || []).push(it); });
  Object.keys(pools).sort((a, b) => POOL_ORDER.indexOf(a) - POOL_ORDER.indexOf(b)).forEach(p => {
    const items = pools[p].sort((a, b) => SEC_ORDER.indexOf(a.sec) - SEC_ORDER.indexOf(b.sec));
    const layout = packPool(items, cap);
    layout.forEach((row, ri) => out.push({fam: (POOL_NAMES[p] || p) + (layout.length > 1 ? ' #' + (ri + 1) : ''), row}));
  });
  return out;
}
const SHORT = {cpu:'cpu', mem:'memory', limits:'limits', diskio:'disk-io', space:'disk-space', net:'network', health:'health', dirs:'directories', docker:'docker', diag:'diagnostics', caddy:'caddy', traefik:'traefik', dbc:'db-census', proxy:'proxysql'};
const AREA = {cpu:'core', mem:'core', limits:'core', diskio:'io', space:'io', net:'io', health:'fp', dirs:'fp', docker:'fp', diag:'diag', caddy:'web', traefik:'web', dbc:'db', proxy:'db'};
function presenceClass(items){
  if (items.every(i => i.req === 'docker')) return 'docker';
  if (items.every(i => i.req === 'db' || (i.req || '').startsWith('db:'))) return 'db';
  return 'always';
}
/* Smart packing: per presence class, fewest rows (first-fit decreasing on whole sections, split only
   when it saves a row), ties broken by subject affinity; fields inside a row sorted by subject. */
function autoLayout(items, cap){
  const bySec = {};
  items.forEach(it => (bySec[it.sec] = bySec[it.sec] || []).push(it));
  const secCat = sec => (bySec[sec].find(i => i.kind === 'd') || bySec[sec][0]).f.cat;
  const classOf = sec => presenceClass(bySec[sec]);
  const allSecs = Object.keys(bySec).sort((a, b) => SEC_ORDER.indexOf(a) - SEC_ORDER.indexOf(b));
  function pack(secs){
    const chunks = [];
    secs.forEach(sec => {
      const ds = bySec[sec].filter(i => i.kind === 'd');
      let cur = {sec, items:[], size:0};
      ds.forEach(it => { if (cur.size + it.w > 19){ chunks.push(cur); cur = {sec, items:[], size:0}; } cur.items.push(it); cur.size += it.w; });
      if (cur.items.length) chunks.push(cur);
    });
    const minRows = Math.ceil(chunks.reduce((a, c) => a + c.size, 0) / 19);
    chunks.sort((a, b) => (b.size - a.size) || (SEC_ORDER.indexOf(a.sec) - SEC_ORDER.indexOf(b.sec)));
    const rows = [];
    const score = (r, c) => Math.max(0, ...r.secs.map(sx => (AREA[sx] === AREA[c.sec] ? 2 : 0) + (secCat(sx) === secCat(c.sec) ? 1 : 0)));
    const newRow = () => { const r = {d:[], b:[], used:0, secs:[]}; rows.push(r); return r; };
    while (chunks.length){
      const c = chunks.shift();
      const fits = rows.filter(r => 19 - r.used >= c.size);
      let target = null;
      if (fits.length) target = fits.sort((a, b) => (score(b, c) - score(a, c)) || ((19 - a.used) - (19 - b.used)))[0];
      else if (rows.length < minRows) target = newRow();
      else {
        const roomy = rows.slice().sort((a, b) => (19 - b.used) - (19 - a.used))[0];
        const free = 19 - roomy.used, head = [];
        let w = 0;
        for (const it of c.items){ if (w + it.w > free) break; head.push(it); w += it.w; }
        if (head.length && head.length < c.items.length){
          roomy.d.push(...head); roomy.used += w; if (!roomy.secs.includes(c.sec)) roomy.secs.push(c.sec);
          chunks.unshift({sec: c.sec, items: c.items.slice(head.length), size: c.size - w});
          continue;
        }
        target = newRow();
      }
      target.d.push(...c.items); target.used += c.size; if (!target.secs.includes(c.sec)) target.secs.push(c.sec);
    }
    secs.forEach(sec => bySec[sec].filter(i => i.kind === 'b').forEach(it => {
      const pref = rows.filter(r => r.secs.includes(sec)).concat(rows.filter(r => r.secs.some(sx => AREA[sx] === AREA[sec])), rows);
      let r = pref.find(x => x.b.length < cap);
      if (!r) r = newRow();
      r.b.push(it); if (!r.secs.includes(sec)) r.secs.push(sec);
    }));
    rows.forEach(r => {
      r.d.sort((a, b) => (SEC_ORDER.indexOf(a.sec) - SEC_ORDER.indexOf(b.sec)) || (ITEMS.findIndex(x => x.id === a.id) - ITEMS.findIndex(x => x.id === b.id)));
      r.secs.sort((a, b) => SEC_ORDER.indexOf(a) - SEC_ORDER.indexOf(b));
    });
    rows.sort((a, b) => SEC_ORDER.indexOf(a.secs[0]) - SEC_ORDER.indexOf(b.secs[0]));
    return rows;
  }
  // Optional groups ride along in rows every host writes when that costs no extra row;
  // otherwise they get their own rows, which hosts without them skip.
  let base = allSecs.filter(sec => classOf(sec) === 'always');
  const groups = [];
  ['docker','db'].forEach(cls => {
    const extra = allSecs.filter(sec => classOf(sec) === cls);
    if (!extra.length) return;
    if (base.length && pack(base.concat(extra)).length === pack(base).length) base = base.concat(extra);
    else groups.push(extra);
  });
  const out = [];
  [base].concat(groups).forEach(secs => { if (secs.length) pack(secs).forEach(r => out.push({fam: r.secs.map(sx => SHORT[sx] || sx).join(' + '), row: r})); });
  return out;
}
function customRows(m, tier, o){
  const t = TIERS.prop[tier];
  const envCount = ITEMS.filter(i => i.sec === 'env' && builder.sel.has(i.id)).length;
  const cap = 20 - envCount;
  const R = [];
  const sel = ITEMS.filter(i => builder.sel.has(i.id) && i.sec !== 'env');
  const mode = MODES[builder.mode];
  const eng = 'postgres';
  // single-entity folds reserve host slots for a lone fs / GPU
  const folded = [];
  if (builder.rules.foldFs) folded.push(...sel.filter(i => i.sec === 'fs').map(i => Object.assign({}, i, {pool:'io', sec:'space', fold:'fs'})));
  if (builder.rules.foldGpu) folded.push(...sel.filter(i => i.sec === 'gpu').map(i => Object.assign({}, i, {pool:'core', sec:'cpu', fold:'gpu'})));
  const hostItems = sel.filter(i => !ENTITY_SECS.includes(i.sec)).concat(folded);
  const groups = builder.mode === 'auto' ? autoLayout(hostItems, cap) : poolLayout(hostItems, cap, mode);
  groups.forEach(({fam, row}) => {
    {
      const pres = it => it.fold === 'fs' ? Math.min(m.fs.length, t.fs) === 1 : it.fold === 'gpu' ? Math.min(m.gpus.length, t.gpu) === 1 && (m.cls === 'physical') : presentOn(it, m, o, eng);
      const anyPresent = row.d.some(pres) || row.b.some(pres);
      if (!anyPresent) return;
      const slots = [];
      row.d.forEach(it => {
        const label = it.fold ? (it.fold === 'fs' ? 'Lone filesystem ' + (m.fs[0] || '') : 'Lone GPU ' + (m.gpus[0] || '')) : null;
        slots.push(...expandDoubles(it, pres(it), label));
      });
      R.push({fam, why: rowWhy(row, pres), slots: fill(slots), blobs: finishBlobs(envBlobs(fam), row.b.map(it => blobOf(it, pres(it)))), custom:true});
    }
  });
  // entity families
  const entity = (sec, list, label) => {
    const fields = sel.filter(i => i.sec === sec);
    const dItems = fields.filter(i => i.kind === 'd'), bItems = fields.filter(i => i.kind === 'b');
    const w = dItems.length, bw = bItems.length;
    if (!w || !list.length) return;
    const per = Math.max(1, Math.min(Math.floor(19 / w), bw ? Math.floor(cap / bw) : 99));
    for (let i = 0; i < list.length; i += per){
      const chunk = list.slice(i, i + per), slots = [], content = [];
      chunk.forEach(e => { dItems.forEach(it => slots.push(sl(it.f, label + ' ' + e, Object.assign({id: it.id}, it.src !== 'v6' ? {nw:true} : {})))); bItems.forEach(it => content.push(Object.assign(blobOf(it, true), {name: it.f.name + ' (' + e + ')', entity: e}))); });
      const fam = SECTIONS.find(s => s[0] === sec)[1].replace('Per ', '').replace(' (3rd onward)', '').replace(' (physical)', '');
      R.push({sec, per, fam: fam.toLowerCase(), why: label + 's, ' + per + ' per row (' + w + ' doubles' + (bw ? ' + ' + bw + ' blobs' : '') + ' each): ' + chunk.join(', ') + '.', slots: fill(slots), blobs: finishBlobs(envBlobs(sec, i / per, chunk.join(',')), content), custom:true});
    }
  };
  const embedded = (builder.sel.has('nic1') ? 1 : 0) + (builder.sel.has('nic2') ? 1 : 0);
  const disks = m.disks.slice(0, t.drive);
  if (!(builder.rules.skipDrive && m.disks.length === 1)) entity('drive', disks, 'Drive');
  entity('nic', m.nics.slice(0, t.nic).slice(embedded), 'NIC');
  if (!(builder.rules.foldFs && Math.min(m.fs.length, t.fs) === 1)) entity('fs', m.fs.slice(0, t.fs), 'Filesystem');
  if (m.cls === 'physical' || o.passthrough) if (!(builder.rules.foldGpu && Math.min(m.gpus.length, t.gpu) === 1 && m.cls === 'physical')) entity('gpu', m.gpus.slice(0, t.gpu), 'GPU');
  if (m.cls === 'physical' && builder.sel.has('sn_value')){
    const sig = m.sensors.slice(0, t.sensors).map(s => s[0]);
    for (let i = 0; i < sig.length; i += 19){
      const chunk = sig.slice(i, i + 19);
      R.push({sec:'sensor', fam:'sensors', why:'Physical only: one value per signal, up to 19 per row (plan cap ' + t.sensors + ').', slots: fill(chunk.map(id => sl(sig2(id), 'Sensor ' + id, {id: 'sn_value'}))), blobs: finishBlobs(envBlobs('sensors', i / 19, chunk.join(',')), []), custom:true});
    }
  }
  return R;
}
function sig2(id){ return {name:id, unit:'value', agg:'avg', cat:'T', desc:'Sensor signal ' + id + '.'}; }
function rowWhy(row, pres){
  const secs = [...new Set(row.d.concat(row.b).map(i => i.fold ? (i.fold === 'fs' ? 'lone filesystem' : 'lone GPU') : SECTIONS.find(s => s[0] === i.sec)[1]))];
  const absent = row.d.concat(row.b).filter(i => !pres(i)).length;
  return 'Holds: ' + secs.join(', ') + '.' + (absent ? ' ' + absent + ' field' + (absent > 1 ? 's are' : ' is') + ' null on this host but keep their slot, so every host shares one layout.' : '');
}

TIERS.custom = TIERS.prop;


module.exports = { ITEMS, ITEM, builder, TIERS, TIER_IDS, MACHINES, buildMachine, customRows, SECTIONS, LIMITS, ENV_LETTER };
