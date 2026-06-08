export const EXPO_TMUX_SESSION = 'expo-ui'
export const EXPO_UI_SERVICE = Deno.env.get('TURBOPANEL_UI_SERVICE') ?? 'turbopanel-ui'

const SNAPSHOT_POLL_MS = 250
const SNAPSHOT_SCROLLBACK = '3000'

export async function expoTmuxStatus(): Promise<{ running: boolean }> {
  const out = await new Deno.Command('tmux', {
    args: ['has-session', '-t', EXPO_TMUX_SESSION],
    stdout: 'null',
    stderr: 'null',
  }).output()
  return { running: out.success }
}

export async function resizeExpoTmuxPane(cols: number, rows: number): Promise<void> {
  const x = String(Math.max(2, Math.min(500, Math.floor(cols))))
  const y = String(Math.max(1, Math.min(200, Math.floor(rows))))
  await new Deno.Command('tmux', {
    args: ['resize-window', '-t', EXPO_TMUX_SESSION, '-x', x, '-y', y],
    stdout: 'null',
    stderr: 'null',
  }).output()
}

export type ExpoPtySize = {
  cols: number
  rows: number
}

type WsAdapter = {
  send: (data: string) => void
  close: () => void
}

async function captureTmuxSnapshot(): Promise<string | null> {
  // Plain capture only — ANSI from `-e` replays badly when Metro uses in-place
  // line updates; tmux already flattens the visible pane.
  const cap = await new Deno.Command('tmux', {
    args: [
      'capture-pane',
      '-t',
      EXPO_TMUX_SESSION,
      '-p',
      '-S',
      `-${SNAPSHOT_SCROLLBACK}`,
    ],
    stdout: 'piped',
    stderr: 'null',
  }).output()
  if (!cap.success || cap.stdout.length === 0) return null
  return new TextDecoder().decode(cap.stdout)
}

async function snapshotFingerprint(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function streamExpoTmuxPty(
  ws: WsAdapter,
  size: ExpoPtySize,
): () => void {
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let lastFingerprint = ''

  const pushSnapshot = async () => {
    if (closed) return
    const text = await captureTmuxSnapshot()
    if (closed || text === null) return

    const fingerprint = await snapshotFingerprint(text)
    if (fingerprint === lastFingerprint) return
    lastFingerprint = fingerprint

    ws.send(JSON.stringify({ type: 'snapshot', data: text }))
  }

  const cleanup = () => {
    if (closed) return
    closed = true
    if (timer) clearInterval(timer)
  }

  void (async () => {
    try {
      await resizeExpoTmuxPane(size.cols, size.rows)
      await pushSnapshot()
      timer = setInterval(() => void pushSnapshot(), SNAPSHOT_POLL_MS)
    } catch {
      cleanup()
      ws.close()
    }
  })()

  return cleanup
}

export async function sendExpoKeys(keys: string): Promise<void> {
  await new Deno.Command('tmux', {
    args: ['send-keys', '-t', EXPO_TMUX_SESSION, keys, ''],
    stdout: 'null',
    stderr: 'null',
  }).output()
}
