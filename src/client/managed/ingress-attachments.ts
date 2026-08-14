/**
 * ProxySQL as a platform attachment on a consuming environment's spanning
 * compose networks. Engines never join those tenant segments — only the
 * shared frontend does, and only when some consumer task is not co-resident
 * with the listener.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db.ts";
import type { ComposeDocument } from "../../lib/compose/types.ts";
import {
  composeNetworkHostName,
  reservedManagedIngressAddress,
} from "../../lib/fabric/cidr.ts";
import {
  composeServiceNetworkKeys,
  type PlatformAttachment,
} from "../../lib/fabric/spanning.ts";
import type { FabricSegmentMaterial } from "../../lib/db/fabric-records.ts";
import {
  binding,
  environment,
  network,
  project,
  segment,
  service,
  task,
} from "../../lib/db/schema.ts";
import {
  parseProjectOptions,
  resolveEffectivePlacementServerId,
} from "../../lib/project-options.ts";

export type { PlatformAttachment };

/** Bound compose service that must reach a ProxySQL listener over spanning nets. */
export type ManagedIngressConsumer = {
  composeServiceName: string;
  networkKeys: string[];
  listenerServerId: string;
};

export type ManagedIngressAttachments = {
  attachments: PlatformAttachment[];
  consumers: ManagedIngressConsumer[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Listener servers that must join a consuming environment's spanning
 * networks because at least one bound consumer task is not co-resident.
 * Two queries (bindings + services); compose keys come from `document`.
 */
export async function loadManagedIngressPlatformAttachments(
  db: Db,
  params: Readonly<{
    environmentId: string;
    document: ComposeDocument;
    tasks: ReadonlyArray<{ serviceId: string; serverId: string }>;
    serviceRows: ReadonlyArray<{ id: string; composeServiceName: string }>;
  }>,
): Promise<ManagedIngressAttachments> {
  const boundRows = await db
    .select({ serviceId: binding.serviceId })
    .from(binding)
    .innerJoin(service, eq(binding.serviceId, service.id))
    .where(eq(service.environmentId, params.environmentId));
  const boundServiceIds = [...new Set(boundRows.map((row) => row.serviceId))];
  if (boundServiceIds.length === 0) {
    return { attachments: [], consumers: [] };
  }

  const placed = await db
    .select({
      id: service.id,
      composeServiceName: service.composeServiceName,
      environmentServerId: environment.serverId,
      projectOptions: project.options,
    })
    .from(service)
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .where(inArray(service.id, boundServiceIds));

  const services = isPlainObject(params.document.data.services)
    ? params.document.data.services
    : {};
  const tasksByService = new Map<string, string[]>();
  for (const row of params.tasks) {
    const servers = tasksByService.get(row.serviceId) ?? [];
    servers.push(row.serverId);
    tasksByService.set(row.serviceId, servers);
  }

  const keysByListener = new Map<string, Set<string>>();
  const consumers: ManagedIngressConsumer[] = [];
  for (const row of placed) {
    const listener = resolveEffectivePlacementServerId(
      row.environmentServerId,
      parseProjectOptions(row.projectOptions),
    );
    if (!listener) continue;
    const consumerServers = tasksByService.get(row.id) ?? [];
    if (consumerServers.every((serverId) => serverId === listener)) {
      continue;
    }
    const body = services[row.composeServiceName];
    const networkKeys = composeServiceNetworkKeys(body)
      .sort((a, b) => a.localeCompare(b));
    const existing = keysByListener.get(listener) ?? new Set<string>();
    for (const key of networkKeys) existing.add(key);
    keysByListener.set(listener, existing);
    consumers.push({
      composeServiceName: row.composeServiceName,
      networkKeys,
      listenerServerId: listener,
    });
  }

  consumers.sort((a, b) =>
    a.composeServiceName.localeCompare(b.composeServiceName)
  );
  return {
    attachments: [...keysByListener.entries()]
      .map(([serverId, networkKeys]) => ({
        serverId,
        networkKeys: [...networkKeys].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.serverId.localeCompare(b.serverId)),
    consumers,
  };
}

/**
 * `tpn_*` host names this server's ProxySQL should join — environments where
 * this host is the listener and at least one consumer task is elsewhere.
 */
export async function loadListenerAttachedSegmentNames(
  db: Db,
  listenerServerId: string,
): Promise<string[]> {
  const bindingRows = await db
    .select({
      serviceId: binding.serviceId,
      environmentServerId: environment.serverId,
      projectOptions: project.options,
    })
    .from(binding)
    .innerJoin(service, eq(binding.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id));

  const serviceIds: string[] = [];
  for (const row of bindingRows) {
    const placement = resolveEffectivePlacementServerId(
      row.environmentServerId,
      parseProjectOptions(row.projectOptions),
    );
    if (placement !== listenerServerId) continue;
    serviceIds.push(row.serviceId);
  }
  if (serviceIds.length === 0) return [];

  const taskRows = await db
    .select({
      serviceId: task.serviceId,
      serverId: task.serverId,
      environmentId: task.environmentId,
    })
    .from(task)
    .where(inArray(task.serviceId, [...new Set(serviceIds)]));

  const remoteEnvIds = new Set<string>();
  for (const row of taskRows) {
    if (row.serverId !== listenerServerId) remoteEnvIds.add(row.environmentId);
  }
  if (remoteEnvIds.size === 0) return [];

  const segmentRows = await db
    .select({ networkId: segment.networkId })
    .from(segment)
    .innerJoin(network, eq(segment.networkId, network.id))
    .where(
      and(
        eq(segment.serverId, listenerServerId),
        inArray(network.environmentId, [...remoteEnvIds]),
        eq(network.kind, "compose"),
      ),
    );

  return [
    ...new Set(segmentRows.map((row) => composeNetworkHostName(row.networkId))),
  ]
    .sort((a, b) => a.localeCompare(b));
}

/**
 * extra_hosts entries for the ProxySQL listener on a consumer host that is
 * not co-resident with it, keyed by the bound compose service name. Empty
 * when this server is the listener for every consumer.
 */
export function reservedIngressHostsForServer(params: {
  thisServerId: string;
  attachments: readonly PlatformAttachment[];
  consumers: readonly ManagedIngressConsumer[];
  spanning: ReadonlyMap<string, string>;
  segmentsByServer: ReadonlyMap<string, readonly FabricSegmentMaterial[]>;
  listenerNameByServer: ReadonlyMap<string, string>;
}): Map<string, Array<{ name: string; address: string }>> {
  const attachmentByServer = new Map(
    params.attachments.map((row) => [row.serverId, row]),
  );
  const byService = new Map<string, Map<string, string>>();
  for (const consumer of params.consumers) {
    if (consumer.listenerServerId === params.thisServerId) continue;
    const listenerName = params.listenerNameByServer.get(
      consumer.listenerServerId,
    );
    if (!listenerName) continue;
    const attachment = attachmentByServer.get(consumer.listenerServerId);
    if (!attachment) continue;
    const cidr = segmentCidrForConsumer(
      consumer,
      attachment,
      params.spanning,
      params.segmentsByServer,
    );
    if (!cidr) continue;
    const address = reservedManagedIngressAddress(cidr);
    if (!address) continue;
    const hosts = byService.get(consumer.composeServiceName) ?? new Map();
    hosts.set(listenerName, address);
    byService.set(consumer.composeServiceName, hosts);
  }
  return new Map(
    [...byService.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([serviceName, hosts]) => [
        serviceName,
        [...hosts.entries()]
          .map(([name, address]) => ({ name, address }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ]),
  );
}

function segmentCidrForConsumer(
  consumer: ManagedIngressConsumer,
  attachment: PlatformAttachment,
  spanning: ReadonlyMap<string, string>,
  segmentsByServer: ReadonlyMap<string, readonly FabricSegmentMaterial[]>,
): string | null {
  const listenerKeys = new Set(attachment.networkKeys);
  const keys = consumer.networkKeys
    .filter((key) => listenerKeys.has(key))
    .sort((a, b) => a.localeCompare(b));
  const segments = segmentsByServer.get(attachment.serverId) ?? [];
  for (const key of keys) {
    const hostName = spanning.get(key);
    if (!hostName) continue;
    const match = segments.find((row) => row.name === hostName);
    if (match) return match.subnet;
  }
  return null;
}
