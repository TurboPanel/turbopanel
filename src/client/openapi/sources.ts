import { buildResourceCrudPaths, clientErrorJson, resourceErrorResponses } from './shared.ts'

export const sourceSchemas = {
  SourceRecord: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      organizationId: { type: 'string' },
      installationId: { type: ['string', 'null'] },
      serviceId: { type: ['string', 'null'] },
      environmentId: { type: ['string', 'null'] },
      credentialId: { type: ['string', 'null'] },
      provider: { type: 'string', enum: ['github', 'gitlab', 'git'] },
      repositoryUrl: { type: 'string' },
      repositoryExternalId: { type: ['string', 'null'] },
      defaultBranch: { type: ['string', 'null'] },
      subdirectory: { type: ['string', 'null'] },
      autoDeploy: {
        type: 'string',
        enum: ['immediate', 'checks_passed', 'disabled'],
      },
      metadata: { type: ['object', 'null'] },
      options: { type: ['object', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
      webhookUrl: {
        type: ['string', 'null'],
        description:
          "Instance webhook endpoint to configure on the provider, on the provider's own " +
          'ingress path. Present on GET /sources/{id} only, and only for github / gitlab ' +
          'sources — provider=git has no webhook surface.',
      },
      webhookReachable: {
        type: 'boolean',
        description:
          'False when this instance only has private/LAN public URLs, so the provider cannot deliver to it.',
      },
      reachabilityNote: {
        type: ['string', 'null'],
        description:
          'Operator-facing explanation when webhookReachable is false; null otherwise.',
      },
    },
  },
  SourcesResponse: {
    type: 'object',
    required: ['sources'],
    properties: {
      sources: {
        type: 'array',
        items: { $ref: '#/components/schemas/SourceRecord' },
      },
    },
  },
  CreateSourceBody: {
    type: 'object',
    required: ['repositoryUrl'],
    properties: {
      provider: {
        type: 'string',
        enum: ['github', 'gitlab', 'git'],
        description: 'Defaults to github',
      },
      repositoryUrl: {
        type: 'string',
        description:
          'https clone URL. provider=git and deploy-key provider=gitlab additionally accept ' +
          'ssh:// or git@host:path when credentialId is set.',
      },
      installationId: {
        type: ['string', 'null'],
        description:
          'Required for provider=github. For provider=gitlab, supply exactly one of ' +
          'installationId (the OAuth connection) or credentialId (a generated deploy key); ' +
          'both together is rejected as source_auth_ambiguous.',
      },
      credentialId: {
        type: ['string', 'null'],
        description:
          'Deploy key from POST /sources/gitlab/deploy-keys. Not supported for provider=github.',
      },
      serviceId: {
        type: ['string', 'null'],
        description: 'Owning service — mutually exclusive with environmentId',
      },
      environmentId: {
        type: ['string', 'null'],
        description: 'Owning environment — mutually exclusive with serviceId',
      },
      repositoryExternalId: { type: ['string', 'null'] },
      defaultBranch: { type: ['string', 'null'] },
      subdirectory: {
        type: ['string', 'null'],
        description: 'Relative path without ".."',
      },
      autoDeploy: {
        type: 'string',
        enum: ['immediate', 'checks_passed', 'disabled'],
      },
      metadata: { type: ['object', 'null'] },
      options: { type: ['object', 'null'] },
    },
  },
  PatchSourceBody: {
    type: 'object',
    description:
      'Scope (serviceId / environmentId) and provider are immutable — recreate the source to rebind.',
    properties: {
      installationId: { type: ['string', 'null'] },
      credentialId: { type: ['string', 'null'] },
      repositoryUrl: { type: 'string' },
      repositoryExternalId: { type: ['string', 'null'] },
      defaultBranch: { type: ['string', 'null'] },
      subdirectory: { type: ['string', 'null'] },
      autoDeploy: {
        type: 'string',
        enum: ['immediate', 'checks_passed', 'disabled'],
      },
      metadata: { type: ['object', 'null'] },
      options: { type: ['object', 'null'] },
    },
  },
  GitProviderInstallationRecord: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      organizationId: { type: 'string' },
      provider: { type: 'string', enum: ['github', 'gitlab'] },
      externalInstallationId: {
        type: 'string',
        description:
          "GitHub App installation id, or the connected GitLab account/group id.",
      },
      accountLogin: { type: ['string', 'null'] },
      accountType: { type: ['string', 'null'] },
      suspendedAt: { type: ['string', 'null'], format: 'date-time' },
      suspended: { type: 'boolean' },
      metadata: { type: ['object', 'null'] },
      options: { type: ['object', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  GitProviderInstallationsResponse: {
    type: 'object',
    required: ['installations'],
    properties: {
      installations: {
        type: 'array',
        items: { $ref: '#/components/schemas/GitProviderInstallationRecord' },
      },
    },
  },
  GitlabDeployKeyBody: {
    type: 'object',
    required: ['name'],
    properties: {
      name: {
        type: 'string',
        description:
          'Label for the credential, also used as the key comment shown in GitLab.',
      },
    },
  },
  GitlabDeployKeyResponse: {
    type: 'object',
    required: ['ok', 'credentialId', 'publicKey', 'fingerprint'],
    properties: {
      ok: { type: 'boolean' },
      credentialId: {
        type: 'string',
        description: 'Pass as credentialId when creating the gitlab source.',
      },
      publicKey: {
        type: 'string',
        description:
          'ssh-ed25519 line to add to the GitLab project as a READ-ONLY Deploy Key. ' +
          'Returned once — the private half never leaves the instance unsealed.',
      },
      fingerprint: { type: 'string' },
    },
  },
  GithubRepositoriesResponse: {
    type: 'object',
    required: ['repositories'],
    properties: {
      repositories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            fullName: { type: 'string' },
            defaultBranch: { type: ['string', 'null'] },
            private: { type: 'boolean' },
            cloneUrl: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
}

const basePaths = buildResourceCrudPaths({
  plural: 'sources',
  singular: 'source',
  tag: 'Sources',
  listSchema: 'SourcesResponse',
  rowSchema: 'SourceRecord',
  createSchema: 'CreateSourceBody',
  patchSchema: 'PatchSourceBody',
})

const sourcesBasePath = '/api/client/v1/sources'
const sourceIdPath = `${sourcesBasePath}/{id}`
const security = [{ cookieAuth: [] }]

export const sourcePaths = {
  ...basePaths,
  [sourcesBasePath]: {
    ...(basePaths[sourcesBasePath] as Record<string, unknown>),
    get: {
      ...((basePaths[sourcesBasePath] as Record<string, unknown>).get as Record<
        string,
        unknown
      >),
      parameters: [
        {
          name: 'serviceId',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description: 'List sources owned by this service (at most one filter)',
        },
        {
          name: 'environmentId',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description: 'List sources owned by this environment (at most one filter)',
        },
      ],
    },
  },
  [sourceIdPath]: {
    ...(basePaths[sourceIdPath] as Record<string, unknown>),
    delete: {
      ...((basePaths[sourceIdPath] as Record<string, unknown>).delete as Record<
        string,
        unknown
      >),
      responses: {
        ...(((basePaths[sourceIdPath] as Record<string, unknown>).delete as Record<
          string,
          unknown
        >).responses as Record<string, unknown>),
        '409': {
          description: 'source_referenced_by_compose',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
  },
  [`${sourcesBasePath}/installations`]: {
    get: {
      tags: ['Sources'],
      summary: 'List Git provider App installations',
      description: 'Reads persisted installation rows only — no live provider call.',
      security,
      responses: {
        '200': {
          description: 'Installations granted to the signed-in organization',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/GitProviderInstallationsResponse' },
            },
          },
        },
        ...resourceErrorResponses({}),
      },
    },
  },
  [`${sourcesBasePath}/installations/{id}/repositories`]: {
    get: {
      tags: ['Sources'],
      summary: 'List repositories visible to an installation',
      description:
        "Dispatches on the installation's provider: mints a short-lived credential per " +
        'request, calls the provider, and discards it.',
      security,
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'Repositories the installation can access',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/GithubRepositoriesResponse' },
            },
          },
        },
        '502': {
          description: 'git_provider_request_failed',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        ...resourceErrorResponses({ badRequest: true, notFound: true }),
      },
    },
  },
  [`${sourcesBasePath}/github/install`]: {
    get: {
      tags: ['Sources'],
      summary: 'Start the GitHub App installation flow',
      description:
        'Redirects to GitHub with a signed `state` binding the flow to the caller organization.',
      security,
      responses: {
        '302': { description: 'Redirect to GitHub' },
        '503': {
          description: 'github_app_not_configured',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        ...resourceErrorResponses({}),
      },
    },
  },
  [`${sourcesBasePath}/github/callback`]: {
    get: {
      tags: ['Sources'],
      summary: 'GitHub App installation callback',
      description:
        'Verifies the signed `state`, then upserts the installation row for the organization.',
      security,
      parameters: [
        { name: 'installation_id', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'setup_action', in: 'query', required: false, schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'Installation recorded',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  id: { type: ['string', 'null'] },
                  setupAction: { type: 'string' },
                },
              },
            },
          },
        },
        ...resourceErrorResponses({ badRequest: true }),
      },
    },
  },
  [`${sourcesBasePath}/gitlab/oauth`]: {
    get: {
      tags: ['Sources'],
      summary: 'Start the GitLab OAuth connect flow',
      description:
        'Redirects to the GitLab authorize endpoint with a signed `state` binding the flow ' +
        "to the caller organization. GitLab has no App install, so this connects one " +
        'account or group rather than selecting repositories.',
      security,
      responses: {
        '302': { description: 'Redirect to GitLab' },
        '503': {
          description: 'gitlab_oauth_not_configured / gitlab_redirect_uri_unknown',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        ...resourceErrorResponses({}),
      },
    },
  },
  [`${sourcesBasePath}/gitlab/callback`]: {
    get: {
      tags: ['Sources'],
      summary: 'GitLab OAuth connect callback',
      description:
        'Verifies the signed `state`, exchanges the code for a token pair, and upserts the ' +
        'installation row. The token pair is sealed onto that row and never returned.',
      security,
      parameters: [
        { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'Connection recorded',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  id: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
        '502': {
          description: 'git_provider_request_failed',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        ...resourceErrorResponses({ badRequest: true }),
      },
    },
  },
  [`${sourcesBasePath}/gitlab/deploy-keys`]: {
    post: {
      tags: ['Sources'],
      summary: 'Generate a read-only deploy keypair',
      description:
        'Mints an Ed25519 keypair, seals the private half into a credential row, and returns ' +
        'the public half **once** for the operator to add to the GitLab project as a ' +
        'read-only Deploy Key. This is the recommended non-human path: the key belongs to ' +
        'the project, so no individual leaving the organization breaks its deploys.',
      security,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/GitlabDeployKeyBody' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Keypair generated; public half returned once',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/GitlabDeployKeyResponse' },
            },
          },
        },
        ...resourceErrorResponses({ badRequest: true }),
      },
    },
  },
}
