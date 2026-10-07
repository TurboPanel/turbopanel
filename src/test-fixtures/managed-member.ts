/**
 * A `ManagedMemberRow` for tests that exercise the HA paths without a
 * database. Test-only (`src/test-fixtures/**` is a Sonar test root).
 */

import type { ManagedMemberRow } from '../features/managed/members.ts'

const STAMP = '2026-10-06T12:00:00.000Z'

/** A ready primary member row (override any field). */
export function managedMemberRow(overrides: Partial<ManagedMemberRow> = {}): ManagedMemberRow {
  return {
    id: '00000000-0000-4000-8000-000000000020',
    managedId: '00000000-0000-4000-8000-000000000001',
    serverId: '550e8400-e29b-41d4-a716-446655440000',
    role: 'primary',
    replicaClass: null,
    readEligible: true,
    ordinal: 1,
    replicationTransport: null,
    privatePort: 5432,
    status: 'ready',
    metadata: null,
    options: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  }
}
