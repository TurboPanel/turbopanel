const DEBUG_ENDPOINT =
  'http://127.0.0.1:7807/ingest/0b79b1a0-6087-4e49-bbd8-5d9dad0c0825'
const DEBUG_SESSION_ID = '79e4fb'

export async function debugLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
): Promise<void> {
  // #region agent log
  try {
    await fetch(DEBUG_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Debug-Session-Id': DEBUG_SESSION_ID,
      },
      body: JSON.stringify({
        sessionId: DEBUG_SESSION_ID,
        location,
        message,
        data,
        hypothesisId,
        timestamp: Date.now(),
      }),
    })
  } catch {
    // ignore ingest failures
  }
  // #endregion
}
