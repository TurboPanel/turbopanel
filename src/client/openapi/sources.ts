import { buildResourceCrudPaths, clientErrorJson, resourceErrorResponses } from './shared.ts'

export const sourceSchemas = {
  OrgGitApp: {
    type: 'object',
    description:
      'A Git provider application this organization may connect through: its ' +
      'own, or one registered instance-wide. Sealed material (App private key, ' +
      'OAuth client secret, webhook secret) is never returned — only presence.',
    properties: {
      id: { type: 'string' },
      organizationId: {
        type: ['string', 'null'],
        description: 'null = instance-wide, usable by every organization',
      },
      provider: { type: 'string', enum: ['github', 'gitlab'] },
      name: { type: 'string' },
      baseUrl: { type: 'string' },
      apiUrl: { type: ['string', 'null'] },
      externalAppId: { type: 'string' },
      appSlug: { type: ['string', 'null'] },
      clientId: { type: ['string', 'null'] },
      redirectUri: { type: ['string', 'null'] },
      webhookRef: {
        type: 'string',
        description: "Routing token in this app's own webhook URL",
      },
      webhookPath: { type: 'string' },
      webhookUrl: { type: ['string', 'null'] },
      readOnly: {
        type: 'boolean',
        description:
          'True for an instance-wide app: usable, but only an instance admin may edit it',
      },
      hasPrivateKey: { type: 'boolean' },
      hasClientSecret: { type: 'boolean' },
      hasWebhookSecret: { type: 'boolean' },
    },
  },
  OrgGitAppsResponse: {
    type: 'object',
    properties: {
      apps: { type: 'array', items: { $ref: '#/components/schemas/OrgGitApp' } },
    },
  },
  OrgGitAppResponse: {
    type: 'object',
    properties: { app: { $ref: '#/components/schemas/OrgGitApp' } },
  },
  CreateOrgGitAppBody: {
    type: 'object',
    required: ['provider', 'name', 'externalAppId'],
    properties: {
      provider: { type: 'string', enum: ['github', 'gitlab'] },
      name: { type: 'string', minLength: 1 },
      externalAppId: { type: 'string', minLength: 1 },
      baseUrl: { type: 'string' },
      apiUrl: { type: ['string', 'null'] },
      appSlug: { type: ['string', 'null'] },
      clientId: { type: ['string', 'null'] },
      redirectUri: { type: ['string', 'null'] },
      privateKeyPem: { type: ['string', 'null'] },
      clientSecret: { type: ['string', 'null'] },
      webhookSecret: { type: ['string', 'null'] },
    },
  },
  PatchOrgGitAppBody: {
    type: 'object',
    description:
      'Partial update — omitted keys keep their stored value, so a PATCH that ' +
      'omits privateKeyPem keeps the sealed one. Send null to clear a nullable ' +
      'field; an empty string is rejected rather than treated as a clear. ' +
      'provider and organizationId are immutable.',
    properties: {
      name: { type: 'string', minLength: 1 },
      externalAppId: { type: 'string', minLength: 1 },
      baseUrl: { type: 'string', minLength: 1 },
      apiUrl: { type: ['string', 'null'] },
      appSlug: { type: ['string', 'null'] },
      clientId: { type: ['string', 'null'] },
      redirectUri: { type: ['string', 'null'] },
      privateKeyPem: { type: ['string', 'null'] },
      clientSecret: { type: ['string', 'null'] },
      webhookSecret: { type: ['string', 'null'] },
    },
  },
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

const gitAppsBasePath = '/api/client/v1/git/apps'

export const sourcePaths = {
  ...basePaths,
  [gitAppsBasePath]: {
    get: {
      tags: ['Sources'],
      summary: "List Git applications this organization may connect through",
      description:
        "The organization's own applications plus every instance-wide one. " +
        'Instance-wide rows come back with `readOnly: true`: usable for a ' +
        'connect flow, but only an instance admin may edit them.',
      security,
      responses: {
        '200': {
          description: 'Available applications',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrgGitAppsResponse' },
            },
          },
        },
        ...resourceErrorResponses({}),
      },
    },
    post: {
      tags: ['Sources'],
      summary: 'Register a Git application for this organization',
      description:
        'Registers an existing GitHub App or GitLab OAuth application. Several ' +
        'may coexist per provider. Secrets are sealed before persist and never ' +
        'returned.',
      security,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateOrgGitAppBody' },
          },
        },
      },
      responses: {
        '201': {
          description: 'The registered application',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrgGitAppResponse' },
            },
          },
        },
        '409': {
          description:
            'An application with these details is already registered. The ' +
            'message is deliberately identical whether the existing row is ' +
            "yours or another organization's — the uniqueness keys are " +
            'instance-global, and a distinguishable answer would let one ' +
            "tenant probe another's registrations.",
          content: { 'application/json': { schema: clientErrorJson } },
        },
        ...resourceErrorResponses({}),
      },
    },
  },
  [`${gitAppsBasePath}/{id}`]: {
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ],
    get: {
      tags: ['Sources'],
      summary: 'Read one Git application',
      security,
      responses: {
        '200': {
          description: 'The application',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrgGitAppResponse' },
            },
          },
        },
        ...resourceErrorResponses({}),
      },
    },
    patch: {
      tags: ['Sources'],
      summary: 'Update one Git application owned by this organization',
      security,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/PatchOrgGitAppBody' },
          },
        },
      },
      responses: {
        '200': {
          description: 'The updated application',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrgGitAppResponse' },
            },
          },
        },
        '403': {
          description:
            'git_app_not_writable — the application is instance-wide',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '409': {
          description: 'An application with these details is already registered',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        ...resourceErrorResponses({}),
      },
    },
    delete: {
      tags: ['Sources'],
      summary: 'Delete one Git application owned by this organization',
      description:
        'Cascades to the connections granted through it. Sources that named ' +
        'those connections survive but lose their clone credential and must be ' +
        'reconnected.',
      security,
      responses: {
        '204': { description: 'Deleted' },
        '403': {
          description:
            'git_app_not_writable — the application is instance-wide',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        ...resourceErrorResponses({}),
      },
    },
  },
  [`${gitAppsBasePath}/github/manifest`]: {
    post: {
      tags: ['Sources'],
      summary: 'Start the GitHub App Manifest flow for this organization',
      description:
        'Returns a manifest to POST to GitHub as a form. Its ' +
        'hook_attributes.url and setup_url already point at this instance, so ' +
        'the created App is self-identifying and its install redirect writes ' +
        'the connection without any manual copying.',
      security,
      responses: {
        '200': {
          description: 'Manifest, target URL, and signed state',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        '503': {
          description: 'public_url_not_configured, or no root secret to sign the state',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        ...resourceErrorResponses({}),
      },
    },
  },
  [`${gitAppsBasePath}/github/manifest/callback`]: {
    get: {
      tags: ['Sources'],
      summary: 'Finish the GitHub App Manifest flow',
      description:
        "Exchanges GitHub's one-shot code for the App credentials and stores " +
        'them. A browser redirect, so the organization is pinned in the query ' +
        'string rather than the usual header.',
      security,
      parameters: [
        { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '201': {
          description: 'The registered application',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrgGitAppResponse' },
            },
          },
        },
        '400': {
          description: 'Missing code/state, or state that does not verify',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '502': {
          description: 'GitHub refused the manifest conversion',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        ...resourceErrorResponses({}),
      },
    },
  },
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
        'Redirects to GitHub with a signed `state` binding the flow to the caller ' +
        'organization **and** to the chosen application.',
      security,
      parameters: [
        {
          name: 'appId',
          in: 'query',
          required: true,
          schema: { type: 'string', format: 'uuid' },
          description:
            'Which registered application to connect through. Required rather ' +
            'than defaulted: an instance may hold several apps per provider, and ' +
            'silently picking one would connect the account to an application ' +
            'the operator did not choose. Must be an app the organization owns ' +
            'or an instance-wide one.',
        },
      ],
      responses: {
        '302': { description: 'Redirect to GitHub' },
        '400': {
          description: 'git_app_required — no usable appId was supplied',
          content: { 'application/json': { schema: clientErrorJson } },
        },
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
        "to the caller organization and to the chosen application. GitLab has no " +
        'App install, so this connects one account or group rather than selecting ' +
        'repositories.',
      security,
      parameters: [
        {
          name: 'appId',
          in: 'query',
          required: true,
          schema: { type: 'string', format: 'uuid' },
          description:
            'Which registered application to connect through. Required rather ' +
            'than defaulted: an instance may hold several apps per provider, and ' +
            'silently picking one would connect the account to an application ' +
            'the operator did not choose. Must be an app the organization owns ' +
            'or an instance-wide one.',
        },
      ],
      responses: {
        '302': { description: 'Redirect to GitLab' },
        '400': {
          description: 'git_app_required — no usable appId was supplied',
          content: { 'application/json': { schema: clientErrorJson } },
        },
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
