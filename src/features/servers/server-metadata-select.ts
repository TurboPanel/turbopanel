/**
 * The `server.metadata` column as read by everything except the hardware
 * reader: without the `hardware` key.
 *
 * `server.metadata.hardware` is the server's latest hardware snapshot
 * (`server-topology-records.ts`), up to 64 KiB of devices, filesystems and
 * sensors. Nearly every other reader of `metadata` wants a handful of small
 * keys (`resources`, `docker`, `services`, `hardwareProfile`, ...), and several
 * run for a whole fleet at a time (the server list, fleet presence, tier
 * enforcement), so they select this expression instead of the bare column and
 * never carry the snapshot. A reader that does need the snapshot goes through
 * `getLatestTopologyGeneration(s)`, which selects that one key and nothing else.
 */
import { sql } from 'drizzle-orm'
import { server } from '../../db/schema.ts'

export const HARDWARE_METADATA_KEY = 'hardware'

export const serverMetadataWithoutHardware = sql<unknown>`(${server.metadata} - ${HARDWARE_METADATA_KEY}::text)`
