import { assertEquals } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
import type { WSContext } from 'hono/ws'
import { getDatabaseUrl } from '../db-url.ts'
import { createDenoDb } from '../db.ts'
import {
  daemonsession,
  organization,
  server,
  serverkey,
} from '../lib/db/schema.ts'
import {
  createDaemonWebSocketSession,
  type DaemonWebSocketIdentity,
} from './ws-handlers.ts'
import type { DaemonMessage } from './hub.ts'
import { listDaemonConnections } from './hub.ts'

const dbUrl = getDatabaseUrl()

type KeyMaterial = {
  privateKey: CryptoKey
  publicJwk: JsonWebKey
  fingerprint: string
}

type MockSocket = {
  ws: WSContext
  sent: DaemonMessage[]
  closes: Array<{ code?: number; reason?: string }>
}

async function generateKeyMaterial(): Promise<KeyMaterial> {
  const pair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const fingerprintData = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(publicJwk)),
  )
  const fingerprint = [...new Uint8Array(fingerprintData)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return {
    privateKey: pair.privateKey,
    publicJwk,
    fingerprint,
  }
}

async function signPayload(privateKey: CryptoKey, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    new TextEncoder().encode(payload),
  )
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
}

function createMockSocket(): MockSocket {
  const sent: DaemonMessage[] = []
  const closes: Array<{ code?: number; reason?: string }> = []
  const ws = {
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      sent.push(JSON.parse(String(data)) as DaemonMessage)
    },
    close(code?: number, reason?: string) {
      closes.push({ code, reason })
    },
  } as WSContext
  return { ws, sent, closes }
}

async function withDaemonAuthDb(
  fn: (db: ReturnType<typeof createDenoDb>) => Promise<void>,
) {
  if (!dbUrl) {
    console.warn('Skipping daemon websocket tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  try {
    await fn(db)
  } finally {
    // Tests clean up per-row during execution.
  }
}

async function seedDaemonIdentity(
  db: ReturnType<typeof createDenoDb>,
): Promise<DaemonWebSocketIdentity & { cleanup: () => Promise<void> }> {
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const key = await generateKeyMaterial()
  await signPayload(key.privateKey, 'daemon-ws-test')

  const [org] = await db
    .insert(organization)
    .values({ displayName: 'Daemon WS Test Org' })
    .returning({ id: organization.id })

  const [serverRow] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId: org.id,
      metadata: { hostname: 'daemon-test' },
    })
    .returning({ id: server.id })

  const [keyRow] = await db
    .insert(serverkey)
    .values({
      serverId: serverRow.id,
      publicKey: key.publicJwk,
      fingerprint: key.fingerprint,
    })
    .returning({ id: serverkey.id })

  const [sessionRow] = await db
    .insert(daemonsession)
    .values({
      serverId: serverRow.id,
      serverKeyId: keyRow.id,
      expiresAt,
    })
    .returning({ id: daemonsession.id })

  return {
    serverId: serverRow.id,
    keyId: keyRow.id,
    sessionId: sessionRow.id,
    cleanup: async () => {
      await db.delete(server).where(eq(server.id, serverRow.id))
      await db.delete(organization).where(eq(organization.id, org.id))
    },
  }
}

Deno.test({
  name: 'JWT-authenticated connect is immediately active',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withDaemonAuthDb(async (db) => {
      const identity = await seedDaemonIdentity(db)
      const socket = createMockSocket()
      const session = createDaemonWebSocketSession(
        socket.ws,
        { db },
        identity,
        { remoteAddress: '127.0.0.1' },
      )
      try {
        assertEquals(socket.sent.some((message) => message.type === 'challenge'), false)
        const entry = listDaemonConnections().find((conn) =>
          conn.serverId === identity.serverId
        )
        assertEquals(Boolean(entry), true)
        assertEquals(entry?.authenticated, true)
      } finally {
        session.onClose()
        await identity.cleanup()
      }
    })
  },
})

Deno.test({
  name: 'ping/pong cycle works after JWT-authenticated connect',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withDaemonAuthDb(async (db) => {
      const identity = await seedDaemonIdentity(db)
      const socket = createMockSocket()
      const session = createDaemonWebSocketSession(
        socket.ws,
        { db },
        identity,
        { remoteAddress: '127.0.0.1' },
      )
      try {
        session.onMessage(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'ping',
              id: crypto.randomUUID(),
              at: new Date().toISOString(),
            } satisfies DaemonMessage),
          }),
          socket.ws,
        )
        assertEquals(socket.sent.some((message) => message.type === 'pong'), true)
      } finally {
        session.onClose()
        await identity.cleanup()
      }
    })
  },
})

Deno.test('touchDaemonSessionLastUsed is called on connect', async () => {
  let touched = false
  const mockDb = {
    update() {
      return {
        set() {
          return {
            where() {
              touched = true
              return Promise.resolve(undefined)
            },
          }
        },
      }
    },
  } as unknown as ReturnType<typeof createDenoDb>

  const socket = createMockSocket()
  const session = createDaemonWebSocketSession(
    socket.ws,
    { db: mockDb },
    {
      serverId: crypto.randomUUID(),
      keyId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
    },
    { remoteAddress: '127.0.0.1' },
  )
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    assertEquals(touched, true)
  } finally {
    session.onClose()
  }
})
