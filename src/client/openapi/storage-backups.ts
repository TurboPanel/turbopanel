/**
 * OpenAPI for storage-copy backups (`client/storage/backup-routes.ts`):
 * scheduled policies and manual backups of one copy. Policy bodies and
 * responses reuse the managed-engine backup-policy schemas
 * (`BackupPolicy`, `CreateBackupPolicyRequest`, …, in `./managed.ts`).
 */

const STORAGE_ID_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const COPY_ID_PARAM = {
  name: 'copyId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const POLICY_ID_PARAM = {
  name: 'policyId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const BACKUP_ID_PARAM = {
  name: 'backupId',
  in: 'path',
  required: true,
  schema: { type: 'string' },
} as const

const TAGS = ['Storage']
const COPY_PARAMS = [STORAGE_ID_PARAM, COPY_ID_PARAM]

function jsonSchema(ref: string) {
  return {
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${ref}` },
      },
    },
  }
}

function requestBody(ref: string) {
  return {
    required: true,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${ref}` },
      },
    },
  }
}

const NOT_FOUND = { description: 'The storage, the copy, or the policy is not found' }
const INVALID = {
  description:
    'backup_policy_invalid / backup_schedule_invalid / backup_timezone_invalid / backup_target_unsupported',
  ...jsonSchema('BackupPolicyInvalidError'),
}
const DISPATCH_CONFLICT = {
  description: 'server_placement_required / server_offline',
  content: {
    'application/json': {
      schema: {
        oneOf: [
          { $ref: '#/components/schemas/ServerPlacementRequiredError' },
          { $ref: '#/components/schemas/ServerOfflineError' },
        ],
      },
    },
  },
}

export const storageBackupSchemas = {
  VolumeBackup: {
    type: 'object',
    required: ['id', 'createdAt', 'copyId', 'policyId', 'sizeBytes', 'checksum', 'path'],
    properties: {
      id: { type: 'string', description: 'The `bk_` id, also the artifact filename on the host' },
      createdAt: { type: 'string', format: 'date-time' },
      copyId: { type: 'string', format: 'uuid' },
      policyId: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'The policy whose scheduled run made it; null for a manual backup',
      },
      sizeBytes: { type: 'integer', minimum: 0 },
      checksum: { type: 'string', description: 'SHA-256 hex of the archive' },
      path: { type: 'string', description: 'Absolute path of the archive on the copy server' },
    },
  },
  VolumeBackupsResponse: {
    type: 'object',
    required: ['backups'],
    properties: {
      backups: { type: 'array', items: { $ref: '#/components/schemas/VolumeBackup' } },
    },
  },
  StorageBackupQueuedResponse: {
    type: 'object',
    required: ['ok', 'backupId', 'commandId', 'serverId'],
    properties: {
      ok: { type: 'boolean', const: true },
      backupId: { type: 'string' },
      commandId: { type: 'string', format: 'uuid' },
      serverId: { type: 'string', format: 'uuid' },
    },
  },
} as const

export const storageBackupPaths = {
  '/api/client/v1/storage/{id}/copies/{copyId}/backup-policies': {
    get: {
      tags: TAGS,
      summary: 'List scheduled backup policies for a storage copy',
      description:
        'Org owners and managers. Each policy with its newest run. Runs are fired by a timer on the copy server.',
      parameters: COPY_PARAMS,
      responses: {
        200: { description: 'Policies, oldest first', ...jsonSchema('BackupPoliciesResponse') },
        404: NOT_FOUND,
      },
    },
    post: {
      tags: TAGS,
      summary: 'Create a scheduled backup policy for a storage copy',
      description:
        "Org owners and managers. A live archive (no pause) of a docker volume, or of a directory under /srv/users/ or the default storage directory. Pushes the copy server's full policy set (`server.backups.reconcile`).",
      parameters: COPY_PARAMS,
      requestBody: requestBody('CreateBackupPolicyRequest'),
      responses: {
        201: { description: 'Policy created', ...jsonSchema('BackupPolicyResponse') },
        400: INVALID,
        404: NOT_FOUND,
        409: { description: 'backup_policy_limit', ...jsonSchema('BackupPolicyLimitError') },
      },
    },
  },
  '/api/client/v1/storage/{id}/copies/{copyId}/backup-policies/{policyId}': {
    patch: {
      tags: TAGS,
      summary: 'Update a storage copy backup policy',
      parameters: [...COPY_PARAMS, POLICY_ID_PARAM],
      requestBody: requestBody('UpdateBackupPolicyRequest'),
      responses: {
        200: { description: 'Policy updated', ...jsonSchema('BackupPolicyResponse') },
        400: INVALID,
        404: NOT_FOUND,
      },
    },
    delete: {
      tags: TAGS,
      summary: 'Delete a storage copy backup policy',
      description: 'The host drops its timer; archives already written stay.',
      parameters: [...COPY_PARAMS, POLICY_ID_PARAM],
      responses: {
        200: { description: 'Policy deleted', ...jsonSchema('DeleteBackupPolicyResponse') },
        404: NOT_FOUND,
      },
    },
  },
  '/api/client/v1/storage/{id}/copies/{copyId}/backup-policies/{policyId}/runs': {
    get: {
      tags: TAGS,
      summary: "List a storage copy backup policy's recent runs",
      parameters: [
        ...COPY_PARAMS,
        POLICY_ID_PARAM,
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      ],
      responses: {
        200: { description: 'Runs, newest first', ...jsonSchema('BackupRunsResponse') },
        404: NOT_FOUND,
      },
    },
  },
  '/api/client/v1/storage/{id}/copies/{copyId}/backups': {
    get: {
      tags: TAGS,
      summary: 'List backups of a storage copy',
      description: 'Manual and scheduled archives, newest first. Org owners and managers.',
      parameters: COPY_PARAMS,
      responses: {
        200: { description: 'Archives', ...jsonSchema('VolumeBackupsResponse') },
        404: NOT_FOUND,
      },
    },
    post: {
      tags: TAGS,
      summary: 'Back up a storage copy now',
      description:
        'Queues `storage.backup` on the copy server: a live archive (no pause) of the copy. The record appears when the command succeeds.',
      parameters: COPY_PARAMS,
      responses: {
        200: { description: 'Queued', ...jsonSchema('StorageBackupQueuedResponse') },
        400: {
          description: 'backup_target_unsupported',
          ...jsonSchema('BackupPolicyInvalidError'),
        },
        404: NOT_FOUND,
        409: DISPATCH_CONFLICT,
      },
    },
  },
  '/api/client/v1/storage/{id}/copies/{copyId}/backups/{backupId}': {
    delete: {
      tags: TAGS,
      summary: 'Delete a storage copy backup',
      description:
        'Queues the archive removal on the copy server; the record goes when it succeeds.',
      parameters: [...COPY_PARAMS, BACKUP_ID_PARAM],
      responses: {
        200: { description: 'Queued', ...jsonSchema('StorageBackupQueuedResponse') },
        400: {
          description: 'backup_target_unsupported',
          ...jsonSchema('BackupPolicyInvalidError'),
        },
        404: { description: 'backup_not_found', ...jsonSchema('BackupNotFoundError') },
        409: DISPATCH_CONFLICT,
      },
    },
  },
  '/api/client/v1/storage/{id}/copies/{copyId}/backups/{backupId}/restore': {
    post: {
      tags: TAGS,
      summary: 'Restore a storage copy from a backup',
      description:
        "Org owners and managers. Queues `storage.restore` on the copy server: the archive's checksum (from its record) is verified first, then the running containers that mount the copy are stopped, its contents are replaced with the archive's, and every container that was stopped is started again, even when the restore fails.",
      parameters: [...COPY_PARAMS, BACKUP_ID_PARAM],
      responses: {
        200: { description: 'Queued', ...jsonSchema('StorageBackupQueuedResponse') },
        400: {
          description: 'backup_target_unsupported',
          ...jsonSchema('BackupPolicyInvalidError'),
        },
        404: { description: 'backup_not_found', ...jsonSchema('BackupNotFoundError') },
        409: DISPATCH_CONFLICT,
      },
    },
  },
} as const
