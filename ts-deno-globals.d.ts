/**
 * Ambient Deno types for the workspace TypeScript language service.
 * Deno runtime, `deno check`, and the Deno LSP use `deno.json` libs and
 * exclude this file; it satisfies editors that type-check via tsconfig.json
 * without the Deno LSP. Do not load it under Deno — it collides with
 * `lib.deno.ns.d.ts` and `@types/node`.
 */

/** Minimal Node/`nodejs_compat` env access for shared modules (Workers + tooling). */
declare const process: {
  env: Record<string, string | undefined>
}

declare namespace Deno {
  const env: {
    get(key: string): string | undefined
    set(key: string, value: string): void
    delete(key: string): void
    toObject(): Record<string, string>
  }

  namespace errors {
    class NotFound extends Error {}
  }

  function addSignalListener(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void
  function serve(
    options: {
      path?: string
      hostname?: string
      port?: number
      signal?: AbortSignal
      onListen?: (
        info: { path: string } | { hostname: string; port: number },
      ) => void | Promise<void>
    },
    handler: (request: Request) => Response | Promise<Response>,
  ): {
    addr: { transport: 'tcp'; hostname: string; port: number } | { transport: 'unix'; path: string }
    finished: Promise<void>
    shutdown: () => Promise<void>
  }
  function connect(
    options: { transport: 'unix'; path: string } | { hostname: string; port: number },
  ): Promise<Conn>
  function chmod(path: string, mode: number): Promise<void>
  function remove(path: string): Promise<void>
  function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  interface FileInfo {
    isFile: boolean
    isDirectory: boolean
    isSymlink: boolean
    isSocket?: boolean
  }

  function stat(path: string | URL): Promise<FileInfo>
  function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void
  function test(
    name: string,
    options: { ignore?: boolean; only?: boolean },
    fn: () => void | Promise<void>,
  ): void
  function readTextFile(path: string | URL): Promise<string>
  function writeTextFile(
    path: string,
    data: string,
    options?: { create?: boolean },
  ): Promise<void>
  function readFile(path: string): Promise<Uint8Array>
  function makeTempFile(options?: { suffix?: string }): Promise<string>
  function hostname(): string
  function networkInterfaces(): Iterable<{
    name: string
    address: string
    family: 'IPv4' | 'IPv6'
    netmask?: string
    scopeid?: number
    cidr?: string
    mac?: string
  }>

  class Command {
    constructor(
      command: string,
      options?: {
        args?: string[]
        cwd?: string
        env?: Record<string, string>
        stdout?: 'null' | 'piped' | 'inherit'
        stderr?: 'null' | 'piped' | 'inherit'
        stdin?: 'null' | 'piped' | 'inherit'
      },
    )
    output(): Promise<{ success: boolean; code: number; stdout: Uint8Array; stderr: Uint8Array }>
    spawn(): ChildProcess
  }

  interface ChildProcess {
    status: Promise<{ success: boolean; code: number }>
    stdout: ReadableStream<Uint8Array> | null
    stderr: ReadableStream<Uint8Array> | null
    kill(signo?: 'SIGTERM' | 'SIGINT'): void
  }

  interface Conn {
    close(): void
  }
}

/** Deno's WebSocket constructor accepts a headers init (not in DOM lib). */
interface WebSocket {
  // keep ambient DOM WebSocket; constructor overload added below
}
declare var WebSocket: {
  prototype: WebSocket
  new (
    url: string | URL,
    protocols?: string | string[] | { headers?: Record<string, string> },
  ): WebSocket
  readonly CONNECTING: 0
  readonly OPEN: 1
  readonly CLOSING: 2
  readonly CLOSED: 3
}

declare module '@std/path' {
  export function dirname(path: string): string
  export function fromFileUrl(url: URL | string): string
  export function join(...pathSegments: string[]): string
}

declare module '@std/encoding/base64' {
  export function encodeBase64(data: ArrayBuffer | Uint8Array): string
}

declare module 'jsr:@std/assert' {
  export function assert(condition: unknown, msg?: string): asserts condition
  export function assertEquals<T>(
    actual: T,
    expected: T,
    msg?: string,
  ): void
  export function assertExists<T>(
    value: T | null | undefined,
    msg?: string,
  ): asserts value is T
  export function assertNotEquals<T>(
    actual: T,
    expected: T,
    msg?: string,
  ): void
  export function assertRejects(
    fn: () => Promise<unknown> | unknown,
    // Match ErrorConstructor / subclass ctors (`unknown[]` rejects Error itself).
    ErrorClass?: abstract new (...args: never[]) => Error,
    msgIncludes?: string,
    msg?: string,
  ): Promise<void>
  export function assertThrows(
    fn: () => unknown,
    // Match ErrorConstructor / subclass ctors (`unknown[]` rejects Error itself).
    ErrorClass?: abstract new (...args: never[]) => Error,
    msgIncludes?: string,
    msg?: string,
  ): void
}

declare module '@std/assert' {
  export * from 'jsr:@std/assert'
}

declare module '@std/testing/bdd' {
  export function describe(name: string, fn: () => void): void
  export function describe(
    name: string,
    options: { ignore?: boolean; only?: boolean },
    fn: () => void,
  ): void
  export function it(name: string, fn: () => void | Promise<void>): void
  export function it(
    name: string,
    options: { ignore?: boolean; only?: boolean },
    fn: () => void | Promise<void>,
  ): void
}

declare module '@std/testing/mock' {
  export interface Stub {
    restore(): void
  }
  export function stub<T>(
    object: T,
    property: keyof T,
    value?: unknown,
  ): Stub
}

/** Minimal `node:buffer` surface for the editor language service (Deno provides the real module). */
declare module 'node:buffer' {
  export class Buffer extends Uint8Array {
    static from(data: Uint8Array | readonly number[] | string): Buffer
  }
}

/** Vite/Vitest `?raw` imports — source text inlined for workerd scan guards. */
declare module '*?raw' {
  const source: string
  export default source
}
