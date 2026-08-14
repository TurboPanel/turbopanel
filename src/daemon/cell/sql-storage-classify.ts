/**
 * Classify a SQLite statement for billing-audit `storageByCallSite` counters.
 * Unrecognized prefixes (e.g. `BEGIN` / `COMMIT`) are ignored — they are not
 * billed as DO SQLite rows the same way SELECT/DML/DDL are.
 */
export function classifyDaemonCellSqlStorageOp(
  query: string,
): "read" | "write" | null {
  const trimmed = query.trimStart().toUpperCase();
  if (
    trimmed.startsWith("SELECT") ||
    trimmed.startsWith("PRAGMA") ||
    trimmed.startsWith("EXPLAIN")
  ) {
    return "read";
  }
  if (
    trimmed.startsWith("INSERT") ||
    trimmed.startsWith("UPDATE") ||
    trimmed.startsWith("DELETE") ||
    trimmed.startsWith("REPLACE") ||
    trimmed.startsWith("CREATE") ||
    trimmed.startsWith("ALTER") ||
    trimmed.startsWith("DROP")
  ) {
    return "write";
  }
  return null;
}
