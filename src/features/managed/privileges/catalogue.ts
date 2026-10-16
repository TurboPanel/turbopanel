/**
 * The versioned privilege catalogue: what each supported engine series can
 * grant, in plain words, and what a site owner's login may hold.
 *
 * Only the series the panel supports are catalogued; a series the panel does
 * not offer has no catalogue, so nothing outside the supported list is ever
 * shown. Data is pure TypeScript and importable from both the Workers and Deno
 * graphs. The daemon does not need it for reading: it reports what the engine
 * says and the control plane classifies it against this catalogue.
 */

import { MANAGED_ENGINE_RELEASES } from '../releases.ts'
import type { ManagedEngineCode } from '../types.ts'
import { MARIADB_PRIVILEGE_DATA, MYSQL_PRIVILEGE_DATA } from './mysql-family.ts'
import { POSTGRES_PRIVILEGE_DATA } from './postgres.ts'
import { existsInSeries } from './series.ts'
import type { EnginePrivilegeData, PrivilegeCatalogue } from './types.ts'

const ENGINE_DATA: Readonly<Partial<Record<ManagedEngineCode, EnginePrivilegeData>>> = {
  postgres: POSTGRES_PRIVILEGE_DATA,
  mysql: MYSQL_PRIVILEGE_DATA,
  mariadb: MARIADB_PRIVILEGE_DATA,
}

/** Series the catalogue covers for `engine`, oldest first. Empty for an unknown engine. */
export function privilegeCatalogueSeries(engine: string): readonly string[] {
  return ENGINE_DATA[engine as ManagedEngineCode]?.series ?? []
}

/**
 * The catalogue for one engine and series, or `undefined` when the panel does
 * not support that series. Entries that do not exist in the series are left out.
 */
export function privilegeCatalogueFor(
  engine: string,
  series: string
): PrivilegeCatalogue | undefined {
  const data = ENGINE_DATA[engine as ManagedEngineCode]
  if (!data?.series.includes(series)) return undefined
  const keep = <T extends { since?: string; removedIn?: string }>(rows: readonly T[]): T[] =>
    rows.filter((row) => existsInSeries(row, series))
  return {
    engine: data.engine,
    series,
    levels: data.levels,
    privileges: keep(data.privileges),
    roles: keep(data.roles),
    attributes: data.attributes,
    membershipOptions: keep(data.membershipOptions),
    defaultPrivilegeObjects: keep(data.defaultPrivilegeObjects),
    blocked: data.blocked,
  }
}

/** Every `(engine, series)` pair the catalogue covers, for tests and tooling. */
export function privilegeCataloguePairs(): { engine: ManagedEngineCode; series: string }[] {
  return Object.values(ENGINE_DATA).flatMap((data) =>
    data.series.map((series) => ({ engine: data.engine, series }))
  )
}

/** Series the release catalogue offers (creatable) that the privilege catalogue does not cover. */
export function uncataloguedCreatableSeries(): { engine: string; series: string }[] {
  return MANAGED_ENGINE_RELEASES.filter(
    (release) =>
      release.tested && !privilegeCatalogueSeries(release.engine).includes(release.series)
  ).map((release) => ({ engine: release.engine, series: release.series }))
}
