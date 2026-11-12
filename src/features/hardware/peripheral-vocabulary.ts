/**
 * Checked vocabularies for the `peripheral` table (host devices a service can
 * be given). The `CHECK` lists in `src/db/schema.ts` are pinned to these arrays
 * by `src/db/enum-checks.test.ts`. Add a member in both places.
 */

/** What a host device is. */
export const PERIPHERAL_KINDS = ['usb', 'serial', 'printer', 'video', 'audio', 'other'] as const

export type PeripheralKind = (typeof PERIPHERAL_KINDS)[number]

/** Whether the host still reports the device. */
export const PERIPHERAL_STATUSES = ['present', 'missing'] as const

export type PeripheralStatus = (typeof PERIPHERAL_STATUSES)[number]
