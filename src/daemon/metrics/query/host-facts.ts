/**
 * Host facts: the short text a v7 sample carries beside its numbers (kernel,
 * OS, versions, a drive's model and SMART verdict, a GPU's driver and model).
 * Both stores answer the same question, "what did this host last tell us about
 * itself", and return the same {@link HostFacts} shape built here.
 */
import {
  METRICS_TEXT_FIELD_NAMES,
  type MetricsSample,
  type MetricsTextFieldName,
} from '../../../contracts/metrics-contract.ts'
import type { HostFacts } from '../types.ts'

export function emptyHostFacts(): HostFacts {
  return { text: {}, blockDevices: [], gpus: [] }
}

/** `true` when a host reported none of its facts. */
export function hostFactsAreEmpty(facts: HostFacts): boolean {
  return (
    Object.keys(facts.text).length === 0 &&
    facts.blockDevices.length === 0 &&
    facts.gpus.length === 0
  )
}

/** Keeps a value only when it is a non-empty string (an empty text blob means "not reported"). */
function present(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** `{ model, smart }`-style record with only the fields that carry text. */
function pickPresent<K extends string>(
  source: unknown,
  keys: readonly K[]
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {}
  if (typeof source !== 'object' || source === null) return out
  for (const key of keys) {
    const value = present((source as Record<string, unknown>)[key])
    if (value !== undefined) out[key] = value
  }
  return out
}

/** Host-wide text, in contract order, without the empty ones. */
export function presentHostText(source: unknown): HostFacts['text'] {
  return pickPresent<MetricsTextFieldName>(source, METRICS_TEXT_FIELD_NAMES)
}

/** Drive entry kept only when it carries text; ordered as given. */
export function presentBlockDeviceFacts(
  entries: readonly { deviceId: string; model?: unknown; smart?: unknown }[]
): HostFacts['blockDevices'] {
  return entries.flatMap((entry) => {
    const text = pickPresent(entry, ['model', 'smart'] as const)
    return Object.keys(text).length === 0 ? [] : [{ deviceId: entry.deviceId, ...text }]
  })
}

/** GPU entry kept only when it carries text; ordered as given. */
export function presentGpuFacts(
  entries: readonly { gpuId: string; driver?: unknown; model?: unknown }[]
): HostFacts['gpus'] {
  return entries.flatMap((entry) => {
    const text = pickPresent(entry, ['driver', 'model'] as const)
    return Object.keys(text).length === 0 ? [] : [{ gpuId: entry.gpuId, ...text }]
  })
}

/** The facts one sample carries (empty when it has no `extended` text, e.g. from a v6 daemon). */
export function hostFactsFromSample(sample: MetricsSample): HostFacts {
  const extended = sample.extended
  if (!extended) return emptyHostFacts()
  return {
    text: presentHostText(extended.text),
    blockDevices: presentBlockDeviceFacts(extended.blockDeviceText ?? []),
    gpus: presentGpuFacts(extended.gpuText ?? []),
  }
}

/** Reads facts back from the JSON a store saved, tolerating a damaged value as "none". */
export function parseStoredHostFacts(raw: unknown): HostFacts {
  if (typeof raw !== 'string' || raw.length === 0) return emptyHostFacts()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyHostFacts()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyHostFacts()
  const record = parsed as Record<string, unknown>
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  return {
    text: presentHostText(record.text),
    blockDevices: presentBlockDeviceFacts(
      list(record.blockDevices).filter(
        (entry): entry is { deviceId: string } =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { deviceId?: unknown }).deviceId === 'string'
      )
    ),
    gpus: presentGpuFacts(
      list(record.gpus).filter(
        (entry): entry is { gpuId: string } =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { gpuId?: unknown }).gpuId === 'string'
      )
    ),
  }
}
