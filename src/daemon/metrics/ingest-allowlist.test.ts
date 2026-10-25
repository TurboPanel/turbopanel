import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  buildMetricsSample,
  METRICS_SCHEMA_VERSION,
  type MetricsSample,
} from '../../contracts/metrics-contract.ts'
import { applyIngestAllowlist, isNoiseFilesystemId, isNoiseNicId } from './ingest-allowlist.ts'

const nic = (deviceId: string) => ({ deviceId })
const fs = (filesystemId: string) => ({ filesystemId })
const block = (deviceId: string) => ({ deviceId })

function sampleWith(parts: Record<string, unknown>): MetricsSample {
  return buildMetricsSample({
    metadata: {
      version: METRICS_SCHEMA_VERSION,
      sampledAt: '2026-10-03T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 1,
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    host: { cpu: {}, kernel: {}, memory: {}, storage: {}, network: {} },
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
    ...parts,
  } as never)
}

describe('ingest allowlist: filesystems', () => {
  it('drops pseudo and runtime mounts and keeps real data mounts', () => {
    for (const id of [
      '/var/lib/docker/overlay2',
      '/run/user/1000',
      '/snap/core',
      '/boot/efi',
      'fs:tmpfs:/dev/shm',
      'fs:overlay:x',
    ]) {
      assertEquals(isNoiseFilesystemId(id), true, id)
    }
    for (const id of [
      '/srv',
      '/srv/proc',
      '/mnt/overlay',
      '/bootstrap',
      '/mnt/data',
      'fs:dev:/dev/sda1',
      '/var/lib/mysql',
    ]) {
      assertEquals(isNoiseFilesystemId(id), false, id)
    }
  })
})

describe('ingest allowlist: NICs', () => {
  const fabric = new Set(['tun-fabric'])
  it('drops loopback, container and bridge devices but never a fabric device', () => {
    for (const id of [
      'lo',
      'veth1a2b',
      'br-3f2',
      'docker0',
      'cni0',
      'flannel.1',
      'virbr0',
      'tap0',
      'tun0',
    ]) {
      assertEquals(isNoiseNicId(id, fabric), true, id)
    }
    assertEquals(isNoiseNicId('eth0', fabric), false)
    assertEquals(isNoiseNicId('enp5s0', fabric), false)
    assertEquals(isNoiseNicId('tun-fabric', fabric), false)
    assertEquals(isNoiseNicId('mac:aa:bb', fabric), false)
  })
})

describe('applyIngestAllowlist', () => {
  it('keeps whole disks, drops partitions of kept disks, arrays and loop devices', () => {
    const out = applyIngestAllowlist(
      sampleWith({
        blockDevices: [
          'sda',
          'sda1',
          'sdb',
          'nvme0n1',
          'nvme0n1p1',
          'md0',
          'loop3',
          'sr0',
          'zram0',
          'mmcblk0',
          'mmcblk0p2',
          'vdb2',
        ].map(block),
      }),
      undefined
    )
    assertEquals(
      out.blockDevices.map((d) => d.deviceId),
      ['sda', 'sdb', 'nvme0n1', 'mmcblk0', 'vdb2']
    )
  })

  it('drops virtual display GPUs and GPUs that report nothing, keeping real ones', () => {
    const out = applyIngestAllowlist(
      sampleWith({
        gpus: [
          { gpuId: 'gpu0', utilizationPercent: 40 },
          { gpuId: 'gpu1', utilizationPercent: 3 },
          { gpuId: 'gpu2' },
        ],
        extended: {
          gpuText: [
            { gpuId: 'gpu0', driver: 'nvidia 570' },
            { gpuId: 'gpu1', driver: 'bochs-drm' },
            { gpuId: 'gpu2', driver: 'amdgpu' },
          ],
          blockDeviceText: [{ deviceId: 'sda1', model: 'x' }],
        },
      }),
      undefined
    )
    assertEquals(
      out.gpus.map((g) => g.gpuId),
      ['gpu0']
    )
    assertEquals(out.extended?.gpuText, [{ gpuId: 'gpu0', driver: 'nvidia 570' }])
    assertEquals(out.extended?.blockDeviceText, [])
  })

  it('drops the sizes of entities the allowlist dropped, keeping those of real ones', () => {
    const out = applyIngestAllowlist(
      sampleWith({
        filesystems: [
          { filesystemId: 'fs:ext4:/mnt/data', availableBytes: 1, freeInodes: 2 },
          { filesystemId: 'fs:tmpfs:/run/user/1000', availableBytes: 1, freeInodes: 2 },
        ],
        gpus: [
          { gpuId: 'gpu0', utilizationPercent: 40 },
          { gpuId: 'gpu1', utilizationPercent: 3 },
        ],
        extended: {
          gpuText: [
            { gpuId: 'gpu0', driver: 'nvidia 570' },
            { gpuId: 'gpu1', driver: 'bochs-drm' },
          ],
          filesystemSizes: [
            { filesystemId: 'fs:ext4:/mnt/data', totalBytes: 10 },
            { filesystemId: 'fs:tmpfs:/run/user/1000', totalBytes: 99 },
          ],
          gpuSizes: [
            { gpuId: 'gpu0', memoryTotalBytes: 16 },
            { gpuId: 'gpu1', memoryTotalBytes: 1 },
          ],
        },
      }),
      undefined
    )
    assertEquals(out.extended?.filesystemSizes, [
      { filesystemId: 'fs:ext4:/mnt/data', totalBytes: 10 },
    ])
    assertEquals(out.extended?.gpuSizes, [{ gpuId: 'gpu0', memoryTotalBytes: 16 }])
  })

  it('filters NICs and filesystems, honouring fabric ids, without mutating the input', () => {
    const input = sampleWith({
      networks: ['eth0', 'veth9', 'wg-fabric', 'tun7'].map(nic),
      filesystems: ['/srv', '/run/lock', '/snap/x'].map(fs),
    })
    const out = applyIngestAllowlist(input, { fabricDeviceIds: ['tun7'] })
    assertEquals(
      out.networks.map((n) => n.deviceId),
      ['eth0', 'wg-fabric', 'tun7']
    )
    assertEquals(
      out.filesystems.map((f) => f.filesystemId),
      ['/srv']
    )
    assertEquals(input.networks.length, 4)
  })

  it('leaves GPU-derived hardware signals alone', () => {
    const out = applyIngestAllowlist(
      sampleWith({
        hardwareSignals: [{ signalId: 'gpu0:temp', kind: 'temperature', value: null }],
      }),
      undefined
    )
    assertEquals(out.hardwareSignals.length, 1)
  })
})
