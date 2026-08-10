import {
  parseDescription,
  parseDisplayName,
} from '../shared.ts'

export type WorkspaceRouteValidationError = {
  ok: false
  error: string
  status: 400
}

export function parseWorkspaceCreateNames(
  body: Record<string, unknown>,
):
  | { ok: true; displayName: string | null; description: string | null }
  | WorkspaceRouteValidationError {
  try {
    return {
      ok: true,
      displayName: parseDisplayName(body),
      description: parseDescription(body),
    }
  } catch {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
}

export function parseWorkspacePatchNames(
  body: Record<string, unknown>,
):
  | {
    ok: true
    patch: { name?: string | null; description?: string | null; updatedAt: string }
  }
  | WorkspaceRouteValidationError {
  const updatedAt = new Date().toISOString()
  const patch: { name?: string | null; description?: string | null; updatedAt: string } = {
    updatedAt,
  }

  if (body.name !== undefined) {
    if (typeof body.name !== 'string') {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    try {
      patch.name = parseDisplayName({ name: body.name })
    } catch {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
  }

  if (body.description !== undefined) {
    if (typeof body.description !== 'string') {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    try {
      patch.description = parseDescription({ description: body.description })
    } catch {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
  }

  return { ok: true, patch }
}
