import {
  isPermissionKey,
  PERMISSIONS,
  type PermissionKey,
} from '../authz/catalog.ts'

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

export function ownerRemovalConflictMessage(err: unknown): string | null {
  if (!(err instanceof Error)) return null
  if (err.message === 'Cannot remove the last owner of an organization') {
    return err.message
  }
  if (err.message === 'Cannot remove the last owner of a team') {
    return err.message
  }
  return null
}

export type AccessRouteValidationError = {
  ok: false
  error: string
  status: 400
}

export type CreateAccessInput = {
  subjectKind: 'user' | 'team' | 'organization'
  subjectId: string
  resourceId: string
  permissionKey: PermissionKey
}

export function parseCreateAccessBody(
  body: unknown,
): CreateAccessInput | AccessRouteValidationError {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }

  const record = body as Record<string, unknown>
  const { subjectKind, subjectId, resourceId, effect, permissionKey } = record

  if (
    subjectKind !== 'user' &&
    subjectKind !== 'team' &&
    subjectKind !== 'organization'
  ) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (typeof subjectId !== 'string' || typeof resourceId !== 'string') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (effect !== undefined && effect !== 'allow') {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (
    typeof permissionKey !== 'string' ||
    permissionKey.length === 0 ||
    !isPermissionKey(permissionKey)
  ) {
    return { ok: false, error: 'permissionKey is required', status: 400 }
  }
  if (!isUuid(resourceId) || !isUuid(subjectId)) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }

  return { subjectKind, subjectId, resourceId, permissionKey }
}

export function validateAccessCheckQuery(
  resourceId: string | undefined,
  permissionKey: string | undefined,
):
  | { ok: true; resourceId: string; permissionKey: PermissionKey }
  | AccessRouteValidationError {
  if (!resourceId || !permissionKey) {
    return {
      ok: false,
      error: 'resourceId and permissionKey query parameters are required',
      status: 400,
    }
  }
  if (!isUuid(resourceId)) {
    return { ok: false, error: 'Invalid resourceId', status: 400 }
  }
  if (!PERMISSIONS.includes(permissionKey as PermissionKey)) {
    return { ok: false, error: 'Invalid permissionKey', status: 400 }
  }
  return { ok: true, resourceId, permissionKey: permissionKey as PermissionKey }
}

export function validateAccessListQuery(
  resourceId: string | undefined,
): { ok: true; resourceId: string } | AccessRouteValidationError {
  if (!resourceId) {
    return {
      ok: false,
      error: 'resourceId query parameter is required',
      status: 400,
    }
  }
  if (!isUuid(resourceId)) {
    return { ok: false, error: 'Invalid resourceId', status: 400 }
  }
  return { ok: true, resourceId }
}

export function validateAccessResourceIdQuery(
  kind: string | undefined,
  itemId: string | undefined,
):
  | { ok: true; kind: string; itemId: string }
  | AccessRouteValidationError {
  if (!kind || !itemId) {
    return {
      ok: false,
      error: 'kind and itemId query parameters are required',
      status: 400,
    }
  }
  return { ok: true, kind, itemId }
}

export function invitationEmailsMatch(
  inviteEmail: string,
  sessionEmail: string,
): boolean {
  return inviteEmail.trim().toLowerCase() === sessionEmail.trim().toLowerCase()
}

export type InvitationAcceptError = 'gone' | 'invalid_grant'

export function invitationAcceptErrorPayload(
  error: InvitationAcceptError,
): { body: { error: string }; status: 400 | 410 } {
  if (error === 'invalid_grant') {
    return { body: { error: 'Invalid invitation grants' }, status: 400 }
  }
  return { body: { error: 'Invitation expired or already used' }, status: 410 }
}

export function organizationResourceIdMismatch(
  kind: string,
  itemId: string,
  organizationId: string,
): boolean {
  return kind === 'organization' && itemId !== organizationId
}
