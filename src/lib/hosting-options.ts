/** Validated `hosting.options` shape including proxy settings. */

export type HostingProxyOptions = {
  forceHttps?: boolean
  gzip?: boolean
  brotli?: boolean
  stripPrefix?: string
}

export type HostingOptions = {
  hostnames?: string[]
  pathPrefix?: string
  targetPort?: number
  proxy?: HostingProxyOptions
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseHostnames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const hostnames = value.filter(
    (h): h is string => typeof h === 'string' && h.length > 0,
  )
  return hostnames.length > 0 ? hostnames : undefined
}

function parseProxyOptions(value: unknown): HostingProxyOptions | undefined {
  if (!isRecord(value)) return undefined

  const proxy: HostingProxyOptions = {}
  const forceHttps = readOptionalBoolean(value.forceHttps)
  if (forceHttps !== undefined) proxy.forceHttps = forceHttps
  const gzip = readOptionalBoolean(value.gzip)
  if (gzip !== undefined) proxy.gzip = gzip
  const brotli = readOptionalBoolean(value.brotli)
  if (brotli !== undefined) proxy.brotli = brotli
  const stripPrefix = readOptionalString(value.stripPrefix)
  if (stripPrefix) proxy.stripPrefix = stripPrefix

  return Object.keys(proxy).length > 0 ? proxy : undefined
}

export function parseHostingOptions(value: unknown): HostingOptions | null {
  if (value === null || value === undefined) return {}
  if (!isRecord(value)) return null

  const options: HostingOptions = {}

  const hostnames = parseHostnames(value.hostnames)
  if (hostnames) options.hostnames = hostnames

  const pathPrefix = readOptionalString(value.pathPrefix)
  if (pathPrefix) options.pathPrefix = pathPrefix

  if (typeof value.targetPort === 'number' && Number.isFinite(value.targetPort)) {
    options.targetPort = value.targetPort
  }

  const proxy = parseProxyOptions(value.proxy)
  if (proxy) options.proxy = proxy

  return options
}

export function resolveHostingProxy(options: HostingOptions | null | undefined): Required<
  Pick<HostingProxyOptions, 'forceHttps' | 'gzip' | 'brotli'>
> & Pick<HostingProxyOptions, 'stripPrefix'> {
  const proxy = options?.proxy
  return {
    forceHttps: proxy?.forceHttps ?? true,
    gzip: proxy?.gzip ?? true,
    brotli: proxy?.brotli ?? false,
    stripPrefix: proxy?.stripPrefix,
  }
}
