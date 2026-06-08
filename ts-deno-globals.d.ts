/**
 * Ambient Deno types for the workspace TypeScript language service.
 * Deno runtime and `deno check` use `deno.json` libs; this file satisfies
 * editors that type-check via tsconfig.json without the Deno LSP.
 */
declare namespace Deno {
  namespace env {
    function get(key: string): string | undefined
    function toObject(): Record<string, string>
  }

  namespace errors {
    class NotFound extends Error {}
  }

  function addSignalListener(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void
  function serve(
    options: {
      path?: string
      signal?: AbortSignal
      onListen?: (info: { path: string }) => void | Promise<void>
    },
    handler: (request: Request) => Response | Promise<Response>,
  ): { shutdown: () => Promise<void> }
  function connect(
    options: { transport: 'unix'; path: string } | { hostname: string; port: number },
  ): Promise<Conn>
  function chmod(path: string, mode: number): Promise<void>
  function remove(path: string): Promise<void>
  function readTextFile(path: string): Promise<string>
  function readFile(path: string): Promise<Uint8Array>
  function makeTempFile(options?: { suffix?: string }): Promise<string>
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

declare module '@std/path' {
  export function dirname(path: string): string
  export function fromFileUrl(url: URL | string): string
  export function join(...pathSegments: string[]): string
}

declare module '@std/encoding/base64' {
  export function encodeBase64(data: ArrayBuffer | Uint8Array): string
}
