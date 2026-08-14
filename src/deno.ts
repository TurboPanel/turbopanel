/**
 * Production Deno entry. Does not import developer modules so `deno task compile`
 * keeps those routes, git/tar/node grants, and Drizzle Studio out of the binary.
 * Development source mode uses {@link ./deno-dev.ts}.
 */
import { startDenoServer } from './deno-server.ts'

await startDenoServer()
