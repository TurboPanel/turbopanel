import { parseServerGeo, type ServerGeo } from "./geo/server-geo.ts";

export type DatacenterNameSuggestion = {
  name: string;
  serverCount: number;
  serverIds: string[];
  serverLabels: string[];
  geo: ServerGeo;
};

type GeoGroup = {
  name: string;
  serverCount: number;
  serverIds: string[];
  serverLabels: string[];
  geo: ServerGeo;
};

function sanitizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/[^A-Za-z0-9 ._-]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 255)
    .trim();
}

function locationLabel(geo: ServerGeo): string | null {
  if (geo.city) {
    const region = geo.regionCode ?? geo.region ?? geo.country;
    return region ? `${geo.city} ${region}` : geo.city;
  }
  return geo.country ?? null;
}

function networkLabel(geo: ServerGeo): string | null {
  const asn = geo.asn === undefined ? null : `AS${geo.asn}`;
  if (geo.asOrganization && asn) return `${geo.asOrganization} ${asn}`;
  return geo.asOrganization ?? asn;
}

/** Suggest one datacenter name from a geo snapshot (same rules as fleet grouping). */
export function suggestDatacenterDisplayNameFromGeo(
  geo: ServerGeo,
): string | null {
  const location = locationLabel(geo);
  const network = networkLabel(geo);
  const rawName = [location, network].filter(
    (part): part is string => part !== null,
  ).join(" - ");
  const name = sanitizeName(rawName);
  return name.length > 0 ? name : null;
}

export type DatacenterSuggestionServerInput = {
  id: string;
  name: string | null;
  hostname: string | null;
  /** True when the server has at least one datacenter membership pin. */
  hasMembership: boolean;
  metadata: unknown;
};

function serverLabel(row: DatacenterSuggestionServerInput): string {
  const label = row.name?.trim();
  if (label) return label;
  const host = row.hostname?.trim();
  if (host) return host;
  return row.id;
}

/**
 * Suggest stable, operator-editable datacenter names from server metadata.
 *
 * Location is preferred because an ASN alone does not identify a physical site.
 * ASN data is retained as a suffix to distinguish colocated providers.
 */
export function suggestDatacenterNames(
  servers: readonly DatacenterSuggestionServerInput[],
  options?: { limit?: number; unassignedOnly?: boolean },
): DatacenterNameSuggestion[] {
  const limit = options?.limit ?? 5;
  const unassignedOnly = options?.unassignedOnly ?? false;
  const groups = new Map<string, GeoGroup>();

  for (const row of servers) {
    if (unassignedOnly && row.hasMembership) continue;
    if (
      typeof row.metadata !== "object" ||
      row.metadata === null ||
      Array.isArray(row.metadata)
    ) {
      continue;
    }
    const geo = parseServerGeo(
      (row.metadata as Record<string, unknown>).geo,
    );
    if (!geo) continue;

    const name = suggestDatacenterDisplayNameFromGeo(geo);
    if (!name) continue;

    const existing = groups.get(name);
    if (existing) {
      existing.serverCount += 1;
      existing.serverIds.push(row.id);
      existing.serverLabels.push(serverLabel(row));
    } else {
      groups.set(name, {
        name,
        serverCount: 1,
        serverIds: [row.id],
        serverLabels: [serverLabel(row)],
        geo,
      });
    }
  }

  if (limit <= 0) return [];

  return [...groups.values()]
    .sort(
      (a, b) =>
        b.serverCount - a.serverCount ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit)
    .map((group) => ({
      name: group.name,
      serverCount: group.serverCount,
      serverIds: group.serverIds,
      serverLabels: group.serverLabels,
      geo: group.geo,
    }));
}
