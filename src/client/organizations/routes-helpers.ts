import {
  parseDefaultEnvironmentNameInput,
  parseMaxServersInput,
} from '../../lib/organization-options.ts'
import { isAllowedTimezone } from '../../lib/timezones.ts'
import { BadRequestError, parseDisplayName } from '../shared.ts'

export type OrganizationRouteValidationError = {
  ok: false
  error: string
  status: 400
}

export type DefaultTimezonePatch = {
  defaultServerTimezone?: string | null
  enforceServerTimezone?: boolean
}

export function parseDefaultTimezonePatch(
  body: Record<string, unknown>,
):
  | { ok: true; patch: DefaultTimezonePatch }
  | OrganizationRouteValidationError {
  const patch: DefaultTimezonePatch = {}

  if ('defaultServerTimezone' in body) {
    if (body.defaultServerTimezone === null) {
      patch.defaultServerTimezone = null
    } else if (
      typeof body.defaultServerTimezone === 'string' &&
      isAllowedTimezone(body.defaultServerTimezone)
    ) {
      patch.defaultServerTimezone = body.defaultServerTimezone
    } else {
      return { ok: false, error: 'Invalid defaultServerTimezone', status: 400 }
    }
  }

  if ('enforceServerTimezone' in body) {
    if (typeof body.enforceServerTimezone !== 'boolean') {
      return { ok: false, error: 'Invalid enforceServerTimezone', status: 400 }
    }
    patch.enforceServerTimezone = body.enforceServerTimezone
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }

  return { ok: true, patch }
}

export function parseDefaultEnvironmentPutBody(
  body: Record<string, unknown>,
):
  | { ok: true; defaultEnvironmentName: string | null }
  | OrganizationRouteValidationError {
  if (!('defaultEnvironmentName' in body)) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }

  const parsed = parseDefaultEnvironmentNameInput(body.defaultEnvironmentName)
  if (!parsed.ok) {
    return {
      ok: false,
      error:
        'defaultEnvironmentName must be null or a non-empty name of at most 255 characters using letters, numbers, spaces, dots, underscores, or hyphens',
      status: 400,
    }
  }

  return { ok: true, defaultEnvironmentName: parsed.value }
}

export function parseServerCapacityPutBody(
  body: Record<string, unknown>,
):
  | { ok: true; maxServers: number | null }
  | OrganizationRouteValidationError {
  if (!('maxServers' in body)) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }

  const parsed = parseMaxServersInput(body.maxServers)
  if (!parsed.ok) {
    return {
      ok: false,
      error: 'maxServers must be a non-negative integer or null',
      status: 400,
    }
  }

  return { ok: true, maxServers: parsed.value }
}

export function parseOrganizationCreateDisplayName(
  body: Record<string, unknown>,
): { ok: true; displayName: string } | OrganizationRouteValidationError {
  try {
    const parsed = parseDisplayName({
      displayName:
        typeof body.displayName === 'string'
          ? body.displayName
          : 'New Organization',
    })
    return { ok: true, displayName: parsed ?? 'New Organization' }
  } catch (error) {
    if (error instanceof BadRequestError) {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    throw error
  }
}
