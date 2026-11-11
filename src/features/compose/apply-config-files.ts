/**
 * Compile Compose `configs:` entries that carry `content` into generated
 * config files.
 *
 * Standard Compose syntax: a top-level `configs.<name>.content` text, mounted
 * by a service's `configs: [{ source, target }]`. The text may use
 * `{$KEY}` / `{$scope.KEY}` references anywhere. Per service, each such config
 * becomes its own source (`<service>_<name>`) and file, so no file is bound
 * into more than one service. Secret values never enter the document or the
 * parts: a secret reference becomes `{ secretKey }` and its value rides sealed
 * in the variable material.
 *
 * `$` rules: a literal `$` is written `$$` (as Compose requires), a literal
 * `{$name}` is written `{$$name}`. Compose `${X}` / `$X` interpolation is
 * refused. References are scanned on the raw text, `$$` is reduced in text
 * parts only, and inserted values are never scanned or reduced again.
 */

import type {
  ApplyVariablesError,
  DeployVariableEntry,
  DeployVariableMaterial,
} from './apply-variables.ts'
import {
  type DeployConfigFileEntry,
  type DeployConfigFilePart,
  type DeployConfigSecretRef,
  configHostPath,
  configRelativePath,
  configSourceName,
  configTextBytes,
  MAX_CONFIG_FILE_TEXT_BYTES,
  MAX_CONFIG_FILES_PER_SERVICE,
  MAX_CONFIG_FILES_TEXT_BYTES_PER_DEPLOY,
} from './config-files.ts'
import {
  hasComposeInterpolation,
  hasEmbeddedRefToken,
  type ParsedVariableRef,
  splitEmbeddedRefs,
} from './variable-refs.ts'

export type ConfigFileWarning = {
  composeServiceName: string
  source: string
  message: string
}

export type ConfigFilesContext = {
  /** The target daemon lists `deploy-config-files-v1`. */
  enabled: boolean
  projectId: string
  environmentId: string
  runDir: string
  secretMaterial: DeployVariableMaterial[]
  files: DeployConfigFileEntry[]
  secretRefs: DeployConfigSecretRef[]
  warnings: ConfigFileWarning[]
}

export function newConfigFilesContext(
  params: Pick<ConfigFilesContext, 'enabled' | 'projectId' | 'environmentId' | 'runDir'> & {
    secretMaterial: DeployVariableMaterial[]
  }
): ConfigFilesContext {
  return { ...params, files: [], secretRefs: [], warnings: [] }
}

export type ConfigLookup = (ref: ParsedVariableRef) => DeployVariableEntry | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fileError(
  composeServiceName: string,
  source: string,
  message: string,
  kind: ApplyVariablesError['kind'] = 'config_file_invalid'
): ApplyVariablesError {
  return { kind, message, composeServiceName, envKey: source }
}

function refLabel(ref: ParsedVariableRef): string {
  return ref.scope ? `{$${ref.scope}.${ref.key}}` : `{$${ref.key}}`
}

function addSecretRef(
  ctx: ConfigFilesContext,
  composeServiceName: string,
  entry: DeployVariableEntry
): void {
  const known = ctx.secretMaterial.some(
    (row) => row.key === entry.key && row.composeServiceName === composeServiceName
  )
  if (!known) {
    ctx.secretMaterial.push({
      key: entry.key,
      composeServiceName,
      forBuild: false,
      forRuntime: false,
      isLiteral: entry.isLiteral,
      valueEnvelope: entry.value,
    })
  }
  if (
    !ctx.secretRefs.some(
      (ref) => ref.key === entry.key && ref.composeServiceName === composeServiceName
    )
  ) {
    ctx.secretRefs.push({ composeServiceName, key: entry.key })
  }
}

function pushText(parts: DeployConfigFilePart[], text: string): void {
  if (text.length === 0) return
  const last = parts.at(-1)
  if (last && 'text' in last) last.text += text
  else parts.push({ text })
}

/** Parts for one `content`, or the error that refuses it. */
function buildParts(
  ctx: ConfigFilesContext,
  composeServiceName: string,
  configName: string,
  content: string,
  lookup: ConfigLookup
): DeployConfigFilePart[] | ApplyVariablesError {
  const parts: DeployConfigFilePart[] = []
  for (const piece of splitEmbeddedRefs(content)) {
    if (piece.kind === 'text') {
      if (hasComposeInterpolation(piece.text)) {
        return fileError(
          composeServiceName,
          configName,
          `Config ${configName} uses Compose interpolation; use {$X} for a variable and $$ for a literal $`,
          'config_interpolation'
        )
      }
      pushText(parts, piece.text.replaceAll('$$', '$'))
      continue
    }
    if (piece.kind === 'invalid') {
      return {
        kind: 'variable_ref_invalid',
        message: piece.message,
        composeServiceName,
        envKey: configName,
      }
    }
    const entry = lookup(piece.ref)
    if (!entry) {
      const labeled = refLabel(piece.ref)
      return {
        kind: 'variable_unresolved',
        message: `Unresolved variable ${labeled} in config ${composeServiceName}.${configName}`,
        ref: labeled,
        composeServiceName,
        envKey: configName,
      }
    }
    if (entry.isSecret) {
      addSecretRef(ctx, composeServiceName, entry)
      parts.push({ secretKey: entry.key })
    } else {
      pushText(parts, entry.value.trim())
    }
  }
  return parts
}

function configEntrySource(item: unknown): string | null {
  if (typeof item === 'string') return item
  if (isRecord(item) && typeof item.source === 'string') return item.source
  return null
}

function warnDroppedOwnership(
  ctx: ConfigFilesContext,
  composeServiceName: string,
  name: string,
  item: unknown
): void {
  if (!isRecord(item)) return
  if (item.uid === undefined && item.gid === undefined && item.mode === undefined) return
  ctx.warnings.push({
    composeServiceName,
    source: name,
    message:
      'Config file owner and mode are fixed: read-only, readable by every user in the container',
  })
}

function validateFile(
  ctx: ConfigFilesContext,
  file: DeployConfigFileEntry,
  configName: string
): ApplyVariablesError | null {
  const { composeServiceName } = file
  if (configName.endsWith('.tmp')) {
    return fileError(
      composeServiceName,
      configName,
      `Config name ${configName} must not end in .tmp`
    )
  }
  if (configTextBytes(file.parts) > MAX_CONFIG_FILE_TEXT_BYTES) {
    return fileError(composeServiceName, configName, `Config ${configName} text is too large`)
  }
  if (
    ctx.files.some(
      (other) => other.source === file.source || other.relativePath === file.relativePath
    )
  ) {
    return fileError(
      composeServiceName,
      configName,
      `Config ${configName} produces a file name another config already uses`
    )
  }
  const sameService = ctx.files.filter((other) => other.composeServiceName === composeServiceName)
  if (sameService.length >= MAX_CONFIG_FILES_PER_SERVICE) {
    return fileError(
      composeServiceName,
      configName,
      'Too many generated config files for one service'
    )
  }
  const total =
    ctx.files.reduce((sum, other) => sum + configTextBytes(other.parts), 0) +
    configTextBytes(file.parts)
  if (total > MAX_CONFIG_FILES_TEXT_BYTES_PER_DEPLOY) {
    return fileError(
      composeServiceName,
      configName,
      'Generated config files are too large together'
    )
  }
  return null
}

function contentOf(spec: unknown): string | null {
  return isRecord(spec) && typeof spec.content === 'string' ? spec.content : null
}

/** The service entry to keep for one content config, or the error that refuses it. */
function compileConfigEntry(
  ctx: ConfigFilesContext,
  composeServiceName: string,
  name: string,
  content: string,
  item: unknown,
  topLevel: Record<string, unknown>,
  lookup: ConfigLookup
): { entry: unknown } | ApplyVariablesError {
  if (!ctx.enabled) {
    if (!hasEmbeddedRefToken(content)) return { entry: item }
    return fileError(
      composeServiceName,
      name,
      `Config ${name} uses {$…} values; update the daemon on this server first`,
      'config_files_need_daemon_update'
    )
  }
  const parts = buildParts(ctx, composeServiceName, name, content, lookup)
  if (!Array.isArray(parts)) return parts
  const file: DeployConfigFileEntry = {
    composeServiceName,
    source: configSourceName(composeServiceName, name),
    relativePath: configRelativePath(composeServiceName, name),
    parts,
  }
  const invalid = validateFile(ctx, file, name)
  if (invalid) return invalid
  if (isRecord(topLevel[file.source])) {
    return fileError(
      composeServiceName,
      name,
      `Config ${name} would replace the config named ${file.source}`
    )
  }
  warnDroppedOwnership(ctx, composeServiceName, name, item)
  const target = isRecord(item) && typeof item.target === 'string' ? item.target : `/${name}`
  ctx.files.push(file)
  return { entry: { source: file.source, target } }
}

/**
 * Compile one service's content configs. Rewrites the service's `configs`
 * entries and adds one generated top-level `file:` config per entry.
 */
export function applyServiceConfigFiles(
  ctx: ConfigFilesContext,
  service: Record<string, unknown>,
  data: Record<string, unknown>,
  composeServiceName: string,
  lookup: ConfigLookup
): ApplyVariablesError | null {
  if (!Array.isArray(service.configs) || !isRecord(data.configs)) return null
  const topLevel = data.configs
  const next: unknown[] = []
  for (const item of service.configs) {
    const name = configEntrySource(item)
    const content = name === null ? null : contentOf(topLevel[name])
    if (name === null || content === null) {
      next.push(item)
      continue
    }
    const compiled = compileConfigEntry(
      ctx,
      composeServiceName,
      name,
      content,
      item,
      topLevel,
      lookup
    )
    if ('kind' in compiled) return compiled
    next.push(compiled.entry)
  }
  service.configs = next
  return null
}

/**
 * After every service: add the generated top-level configs, drop the content
 * configs that were compiled (or are unused), and refuse a service that names
 * another service's generated source.
 */
export function finishConfigFiles(
  ctx: ConfigFilesContext,
  data: Record<string, unknown>
): ApplyVariablesError | null {
  if (!ctx.enabled || !isRecord(data.configs)) return null
  const topLevel = { ...data.configs }
  const services = isRecord(data.services) ? data.services : {}
  for (const [name, service] of Object.entries(services)) {
    if (!isRecord(service) || !Array.isArray(service.configs)) continue
    for (const item of service.configs) {
      const source = configEntrySource(item)
      const owner = ctx.files.find((file) => file.source === source)
      if (owner && owner.composeServiceName !== name) {
        return fileError(
          name,
          source ?? '',
          `Config ${source} belongs to service ${owner.composeServiceName}, not ${name}`,
          'config_file_shared'
        )
      }
    }
  }
  for (const [name, spec] of Object.entries(topLevel)) {
    if (isRecord(spec) && typeof spec.content === 'string') delete topLevel[name]
  }
  for (const file of ctx.files) {
    topLevel[file.source] = {
      file: configHostPath(ctx.projectId, ctx.environmentId, file.relativePath, ctx.runDir),
    }
  }
  if (Object.keys(topLevel).length === 0) delete data.configs
  else data.configs = topLevel
  return null
}
