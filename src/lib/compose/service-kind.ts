/** Per-service `x-turbopanel` extension (Compose `services.<name>.x-turbopanel`). */

export const TURBOPANEL_SERVICE_EXTENSION_KEY = 'x-turbopanel'

export type ComposeServiceKind = 'container' | 'traditional-web'

export type TraditionalWebEngine = 'apache' | 'nginx' | 'openlitespeed'

/** Max length for operator-facing service description metadata. */
export const SERVICE_DESCRIPTION_MAX_LENGTH = 500

export type ComposeServiceTurbopanelExtension = {
  serviceKind?: ComposeServiceKind
  engine?: TraditionalWebEngine
  /**
   * Document-root segment under the daemon site directory (relative only).
   * Default `public` when omitted for traditional-web.
   */
  root?: string
  /**
   * Optional human description (TurboPanel-only metadata; not used by Docker).
   */
  description?: string
}

const SERVICE_KINDS = new Set<ComposeServiceKind>(['container', 'traditional-web'])
const TRADITIONAL_WEB_ENGINES = new Set<TraditionalWebEngine>([
  'apache',
  'nginx',
  'openlitespeed',
])

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readServiceKind(value: unknown): ComposeServiceKind | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!SERVICE_KINDS.has(trimmed as ComposeServiceKind)) return undefined
  return trimmed as ComposeServiceKind
}

function readTraditionalWebEngine(value: unknown): TraditionalWebEngine | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!TRADITIONAL_WEB_ENGINES.has(trimmed as TraditionalWebEngine)) return undefined
  return trimmed as TraditionalWebEngine
}

export function parseServiceTurbopanelExtension(
  value: unknown,
): ComposeServiceTurbopanelExtension | null {
  if (value === null || value === undefined) return {}
  if (!isPlainMapping(value)) return null

  const extension: ComposeServiceTurbopanelExtension = {}
  const serviceKind = readServiceKind(value.serviceKind)
  if (serviceKind) extension.serviceKind = serviceKind
  const engine = readTraditionalWebEngine(value.engine)
  if (engine) extension.engine = engine
  if (typeof value.root === 'string') {
    const root = value.root.trim()
    if (root.length > 0) extension.root = root
  }
  if (typeof value.description === 'string') {
    const description = value.description.trim()
    if (
      description.length > 0 &&
      description.length <= SERVICE_DESCRIPTION_MAX_LENGTH
    ) {
      extension.description = description
    }
  }

  return extension
}

export function readServiceTurbopanelExtension(
  service: Record<string, unknown>,
): ComposeServiceTurbopanelExtension | null {
  if (!(TURBOPANEL_SERVICE_EXTENSION_KEY in service)) return {}
  return parseServiceTurbopanelExtension(service[TURBOPANEL_SERVICE_EXTENSION_KEY])
}

export function isTraditionalWebComposeService(
  service: Record<string, unknown>,
): boolean {
  const extension = readServiceTurbopanelExtension(service)
  if (extension === null) return false
  return extension.serviceKind === 'traditional-web'
}

export type ServiceTurbopanelValidationIssue = {
  path: string
  message: string
}

function validateRawExtensionFieldTypes(
  basePath: string,
  rawExtension: unknown,
): ServiceTurbopanelValidationIssue[] {
  if (!isPlainMapping(rawExtension)) return []
  const issues: ServiceTurbopanelValidationIssue[] = []

  if ('serviceKind' in rawExtension && !readServiceKind(rawExtension.serviceKind)) {
    issues.push({
      path: `${basePath}.serviceKind`,
      message: 'serviceKind must be "container" or "traditional-web"',
    })
  }

  if ('engine' in rawExtension && !readTraditionalWebEngine(rawExtension.engine)) {
    issues.push({
      path: `${basePath}.engine`,
      message: 'engine must be "apache", "nginx", or "openlitespeed"',
    })
  }

  if ('description' in rawExtension) {
    const description = rawExtension.description
    if (typeof description !== 'string') {
      issues.push({
        path: `${basePath}.description`,
        message: 'description must be a string',
      })
    } else if (description.trim().length > SERVICE_DESCRIPTION_MAX_LENGTH) {
      issues.push({
        path: `${basePath}.description`,
        message: `description must be at most ${SERVICE_DESCRIPTION_MAX_LENGTH} characters`,
      })
    }
  }

  return issues
}

function validateEngineConsistency(
  basePath: string,
  parsed: ComposeServiceTurbopanelExtension,
): ServiceTurbopanelValidationIssue[] {
  const issues: ServiceTurbopanelValidationIssue[] = []

  if (parsed.serviceKind === 'traditional-web' && !parsed.engine) {
    issues.push({
      path: `${basePath}.engine`,
      message: 'traditional-web services require engine',
    })
  }

  if (parsed.engine && parsed.serviceKind !== 'traditional-web') {
    issues.push({
      path: `${basePath}.engine`,
      message: 'engine is only valid when serviceKind is traditional-web',
    })
  }

  return issues
}

function validateRootConsistency(
  basePath: string,
  parsed: ComposeServiceTurbopanelExtension,
): ServiceTurbopanelValidationIssue[] {
  if (parsed.root === undefined) return []

  if (parsed.serviceKind !== 'traditional-web') {
    return [
      {
        path: `${basePath}.root`,
        message: 'root is only valid when serviceKind is traditional-web',
      },
    ]
  }

  if (isSafeRoot(parsed.root)) return []
  return [
    {
      path: `${basePath}.root`,
      message: 'root must be a relative path without ".." (e.g. "public" or "www")',
    },
  ]
}

function collectServiceExtensionValidationIssues(
  basePath: string,
  rawService: Record<string, unknown>,
): ServiceTurbopanelValidationIssue[] {
  if (!(TURBOPANEL_SERVICE_EXTENSION_KEY in rawService)) return []

  const rawExtension = rawService[TURBOPANEL_SERVICE_EXTENSION_KEY]
  const parsed = parseServiceTurbopanelExtension(rawExtension)
  if (parsed === null) {
    return [{ path: basePath, message: 'x-turbopanel must be a mapping' }]
  }

  return [
    ...validateRawExtensionFieldTypes(basePath, rawExtension),
    ...validateEngineConsistency(basePath, parsed),
    ...validateRootConsistency(basePath, parsed),
  ]
}

export function collectServiceTurbopanelValidationIssues(
  services: Record<string, unknown>,
): ServiceTurbopanelValidationIssue[] {
  const issues: ServiceTurbopanelValidationIssue[] = []

  for (const [name, rawService] of Object.entries(services)) {
    if (!isPlainMapping(rawService)) continue
    const basePath = `services.${name}.x-turbopanel`
    issues.push(...collectServiceExtensionValidationIssues(basePath, rawService))
  }

  return issues
}

function isSafeRoot(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 200) return false
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return false
  if (trimmed.includes('..')) return false
  if (trimmed.includes('\0')) return false
  return /^[A-Za-z0-9._/-]+$/.test(trimmed)
}
