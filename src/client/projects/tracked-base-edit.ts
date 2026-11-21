/**
 * What a `PATCH /projects/:id` may change while the project's Base follows its
 * repository's compose file.
 *
 * The Base document (`options.compose`, `options.composeOverlays`) and the
 * source it follows (`composeSource`, except `mode`, which belongs to
 * `PATCH /projects/:id/compose-source`) cannot be changed: the next deploy
 * would overwrite them. The settings stored next to them (Keep Original Names
 * as `options.containerNaming`, the default server pin as
 * `options.defaultServerId`, the deploy tuning keys) are not part of the Base
 * and save as usual.
 *
 * The UI saves the Base editor's whole options object, so a document that is
 * sent back unchanged is not an edit. Options are written whole, so the stored
 * document is put back into every options write.
 */
import { stripComposePlacement } from '../../features/compose/placement.ts'
import { CONFIGURATION_OPTION_KEYS } from './edit-target.ts'
import { isComposeDocument, validateComposeDocument } from '../../features/compose/validate.ts'
import {
  parseProjectOptions,
  type ProjectComposeSource,
} from '../../features/projects/project-options.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The sent document is the stored one, as stored or as the write path would normalize it. */
function sameDocument(sent: unknown, stored: unknown): boolean {
  if (sameJson(sent, stored)) return true
  const validated = validateComposeDocument(sent)
  if (!validated.ok) return false
  const normalized = isComposeDocument(validated.document)
    ? stripComposePlacement(validated.document)
    : validated.document
  return sameJson(normalized, stored)
}

function sameLayerValue(key: string, sent: unknown, stored: unknown): boolean {
  if (key === 'composeOverlays') return sameJson(sent ?? [], stored ?? [])
  return sameDocument(sent, stored)
}

const SOURCE_KEYS = ['sourceId', 'ref', 'path', 'seededCommitSha', 'seededDigest'] as const

function sameSource(sent: unknown, stored: ProjectComposeSource): boolean {
  if (!isRecord(sent)) return false
  return SOURCE_KEYS.every((key) => sameJson(sent[key], stored[key]))
}

/**
 * True when the body changes the Base document or the source it follows (the
 * caller answers 409 `base_tracks_repository`). Only for a project that is
 * tracking and a body that is not an environment edit.
 */
export function changesTrackedBase(body: Record<string, unknown>, storedOptions: unknown): boolean {
  if (!isRecord(body.options)) return false
  const stored = isRecord(storedOptions) ? storedOptions : {}
  for (const key of CONFIGURATION_OPTION_KEYS) {
    if (key in body.options && !sameLayerValue(key, body.options[key], stored[key])) return true
  }
  const source = parseProjectOptions(stored).composeSource
  return Boolean(
    source && 'composeSource' in body.options && !sameSource(body.options.composeSource, source)
  )
}

/** Options are written whole: put the stored Base document back into the options about to be written. */
export function keepTrackedBase(storedOptions: unknown, options: Record<string, unknown>): void {
  const stored = isRecord(storedOptions) ? storedOptions : {}
  for (const key of CONFIGURATION_OPTION_KEYS) {
    if (key in stored) options[key] = stored[key]
    else delete options[key]
  }
}
