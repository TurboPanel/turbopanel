/** PostgreSQL undefined_table — schema not migrated yet. */
export function isMissingRelationError(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '42P01'
}
