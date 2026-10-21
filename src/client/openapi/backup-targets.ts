import { resourceErrorResponses } from './shared.ts'

/**
 * OpenAPI for backup copy targets (`client/organizations/backup-target-routes.ts`):
 * named S3-compatible destinations an organization copies finished backups to,
 * the organization default, and each cluster's own choice. Owners and managers
 * only. The secret access key is write-only: it is accepted on create and
 * update and never appears in any response.
 */

const ORG_ID_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const TARGET_ID_PARAM = {
  name: 'targetId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const MANAGED_ID_PARAM = {
  name: 'managedId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const TARGET_FIELDS = {
  name: { type: 'string', minLength: 1, maxLength: 64 },
  endpoint: {
    type: 'string',
    description:
      'Base URL of the storage service, `https://` only. Plain `http://` is accepted for an address on a private network. Loopback, link-local and metadata addresses are refused.',
  },
  region: { type: 'string', description: 'Region used when signing, such as `us-east-1`.' },
  bucket: { type: 'string', minLength: 3, maxLength: 63 },
  prefix: {
    type: 'string',
    description: 'Folder inside the bucket, without a leading or trailing slash. Optional.',
  },
  pathStyle: {
    type: 'boolean',
    description: 'True (the default) puts the bucket in the path; most self-hosted providers need it.',
  },
  serverSideEncryption: {
    type: 'boolean',
    description: 'Ask the storage to encrypt each object at rest. Optional, off by default.',
  },
  accessKeyId: { type: 'string' },
} as const

export const backupTargetSchemas = {
  BackupTarget: {
    type: 'object',
    description: 'A copy target. The secret access key is never part of it.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      ...TARGET_FIELDS,
      kind: { type: 'string', enum: ['s3'] },
      hasSecret: { type: 'boolean', description: 'Always true: a secret key is stored sealed.' },
      lastTestedAt: { type: ['string', 'null'], format: 'date-time' },
      lastTestOk: { type: ['boolean', 'null'] },
      lastTestError: { type: ['string', 'null'], description: 'A plain reason the last test failed.' },
      createdBy: { type: ['string', 'null'], format: 'uuid' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  BackupTargetCreate: {
    type: 'object',
    required: ['name', 'endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'],
    properties: {
      ...TARGET_FIELDS,
      secretAccessKey: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        writeOnly: true,
        description: 'Stored sealed and never returned.',
      },
    },
  },
  BackupTargetUpdate: {
    type: 'object',
    description:
      'Only the fields present change. Leave `secretAccessKey` out to keep the stored one. Changing where the target points clears its last test.',
    properties: {
      ...TARGET_FIELDS,
      secretAccessKey: { type: 'string', minLength: 1, maxLength: 256, writeOnly: true },
    },
  },
  BackupTargetCopy: {
    type: ['object', 'null'],
    description:
      "How copying one backup to its target stands. `state` is `pending` (waiting for the server), `copying`, `copied`, `failed` (see `error`) or `removed` (taken out of the bucket by retention). Null when no target applied. Present on each item of the cluster's backup list.",
    properties: {
      state: { type: 'string', enum: ['pending', 'copying', 'copied', 'failed', 'removed'] },
      targetId: { type: ['string', 'null'], format: 'uuid' },
      targetName: { type: 'string' },
      error: { type: ['string', 'null'] },
      objectKey: { type: ['string', 'null'] },
      attempts: { type: 'integer', minimum: 0 },
      copiedAt: { type: ['string', 'null'], format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  ClusterBackupTarget: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        enum: ['cluster', 'organization', 'none'],
        description: "Where the effective target comes from: the cluster's own choice, the organization default, or nowhere.",
      },
      choice: {
        type: 'string',
        enum: ['inherit', 'none', 'target'],
        description: 'The cluster’s own setting: follow the default, copy nowhere, or its own target.',
      },
      target: {
        type: ['object', 'null'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          bucket: { type: 'string' },
          prefix: { type: 'string' },
          lastTestOk: { type: ['boolean', 'null'] },
          lastTestedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
    },
  },
}

function jsonBody(schema: string) {
  return {
    required: true,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
  }
}

function jsonOk(description: string, schema: Record<string, unknown>, status = '200') {
  return { [status]: { description, content: { 'application/json': { schema } } } }
}

function errors(extra?: { badRequest?: boolean }) {
  return resourceErrorResponses({
    badRequest: extra?.badRequest,
    notFound: true,
  }) as Record<string, unknown>
}

const TARGET_RESPONSE = {
  type: 'object',
  properties: { target: { $ref: '#/components/schemas/BackupTarget' } },
}

export const backupTargetPaths: Record<string, unknown> = {
  '/api/client/v1/organizations/{id}/backup-targets': {
    get: {
      tags: ['Organizations'],
      summary: "List the organization's backup copy targets",
      description:
        'Owners and managers only. Also returns the organization default and each cluster that has its own choice (`targetId` null means no copy for that cluster).',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      responses: {
        ...jsonOk('Targets and where they apply', {
          type: 'object',
          properties: {
            targets: { type: 'array', items: { $ref: '#/components/schemas/BackupTarget' } },
            defaultTargetId: { type: ['string', 'null'], format: 'uuid' },
            clusters: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  managedId: { type: 'string', format: 'uuid' },
                  targetId: { type: ['string', 'null'], format: 'uuid' },
                },
              },
            },
          },
        }),
        ...errors(),
      },
    },
    post: {
      tags: ['Organizations'],
      summary: 'Add a backup copy target',
      description:
        'Owners and managers only. At most 20 per organization. The secret access key is sealed at once and never returned. 409 `backup_target_name_taken` or `backup_target_limit`.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      requestBody: jsonBody('BackupTargetCreate'),
      responses: { ...jsonOk('Created', TARGET_RESPONSE, '201'), ...errors({ badRequest: true }) },
    },
  },
  '/api/client/v1/organizations/{id}/backup-targets/default': {
    put: {
      tags: ['Organizations'],
      summary: "Set the organization's default backup copy target",
      description:
        'Owners and managers only. `{ "targetId": null }` removes the default. The servers that run managed backups are sent their policies again.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['targetId'],
              properties: { targetId: { type: ['string', 'null'], format: 'uuid' } },
            },
          },
        },
      },
      responses: {
        ...jsonOk('Saved', {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            defaultTargetId: { type: ['string', 'null'], format: 'uuid' },
            pushedToServers: { type: 'integer', minimum: 0 },
          },
        }),
        ...errors({ badRequest: true }),
      },
    },
  },
  '/api/client/v1/organizations/{id}/backup-targets/clusters/{managedId}': {
    put: {
      tags: ['Organizations'],
      summary: "Set one cluster's own backup copy target",
      description:
        'Owners and managers only. `choice` is `inherit` (follow the organization default), `none` (no copy for this cluster) or a target id.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, MANAGED_ID_PARAM],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['choice'],
              properties: { choice: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        ...jsonOk('Saved', {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            choice: { type: 'string' },
            pushedToServers: { type: 'integer', minimum: 0 },
          },
        }),
        ...errors({ badRequest: true }),
      },
    },
  },
  '/api/client/v1/organizations/{id}/backup-targets/{targetId}': {
    patch: {
      tags: ['Organizations'],
      summary: 'Change a backup copy target',
      description:
        'Owners and managers only. The servers that use the target are sent their policies again.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, TARGET_ID_PARAM],
      requestBody: jsonBody('BackupTargetUpdate'),
      responses: {
        ...jsonOk('Updated', {
          type: 'object',
          properties: {
            target: { $ref: '#/components/schemas/BackupTarget' },
            pushedToServers: { type: 'integer', minimum: 0 },
          },
        }),
        ...errors({ badRequest: true }),
      },
    },
    delete: {
      tags: ['Organizations'],
      summary: 'Delete a backup copy target',
      description:
        'Owners and managers only. Refused with 409 `backup_target_in_use` while it is the organization default or a cluster uses it. Objects already in the bucket are left alone.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, TARGET_ID_PARAM],
      responses: {
        ...jsonOk('Deleted', { type: 'object', properties: { ok: { type: 'boolean' } } }),
        ...errors(),
      },
    },
  },
  '/api/client/v1/organizations/{id}/backup-targets/{targetId}/test': {
    post: {
      tags: ['Organizations'],
      summary: 'Test a backup copy target',
      description:
        'Owners and managers only. Asks one connected server (the one in `serverId`, else any ready one) to write, read back and delete a small object. Returns the command id; the outcome is stored on the target (`lastTestedAt`, `lastTestOk`, `lastTestError`).',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, TARGET_ID_PARAM],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: { type: 'object', properties: { serverId: { type: 'string', format: 'uuid' } } },
          },
        },
      },
      responses: {
        ...jsonOk('Test queued', {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            commandId: { type: 'string', format: 'uuid' },
            serverId: { type: 'string', format: 'uuid' },
          },
        }),
        ...errors({ badRequest: true }),
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/backup-target': {
    get: {
      tags: ['Managed'],
      summary: "Where a cluster's backups are copied",
      description:
        "The target in effect for the environment's managed database: its own choice, else the organization default.",
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        ...jsonOk('Effective target', { $ref: '#/components/schemas/ClusterBackupTarget' }),
        ...errors(),
      },
    },
  },
}
