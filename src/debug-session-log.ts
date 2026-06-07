const DEBUG_ENDPOINT =
  'http://localhost:7686/ingest/1326dc58-69fc-4780-871a-d504ad5cb2c6'
const DEBUG_SESSION_ID = '9bf570'

export function debugSessionLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
  runId = 'pre-fix',
): void {
  const payload = {
    sessionId: DEBUG_SESSION_ID,
    runId,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  }
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': DEBUG_SESSION_ID,
    },
    body: JSON.stringify(payload),
  }).catch(() => {})
  // #endregion
}
