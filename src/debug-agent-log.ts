const DEBUG_LOG_PATH = '/opt/turbopanel/platform/turbopanel/.cursor/debug-f89c14.log'

export function agentDebugLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
  runId = 'pre-fix',
): void {
  const payload = {
    sessionId: 'f89c14',
    runId,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  }

  // #region agent log
  fetch('http://localhost:7686/ingest/1326dc58-69fc-4780-871a-d504ad5cb2c6', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': 'f89c14',
    },
    body: JSON.stringify(payload),
  }).catch(() => {})
  Deno.writeTextFile(DEBUG_LOG_PATH, `${JSON.stringify(payload)}\n`, { append: true })
    .catch(() => {})
  // #endregion
}
