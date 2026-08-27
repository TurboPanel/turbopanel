import { buildResourceCrudPaths, clientErrorJson, resourceErrorResponses } from './shared.ts'

export const repositorySchemas = {
  OrgForge: {
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
  OrgForgesResponse: {
    type: 'object',
    properties: {
      apps: { type: 'array', items: { $ref: '#/components/schemas/OrgForge' } },
    },
  },
  OrgForgeResponse: {
    type: 'object',
    properties: { app: { $ref: '#/components/schemas/OrgForge' } },
  },
  CreateOrgForgeBody: {
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
  PatchOrgForgeBody: {
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
  RepositoryRecord: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      organizationId: { type: 'string' },
      connectionId: { type: ['string', 'null'] },
      serviceId: { type: ['string', 'null'] },
      environmentId: { type: ['string', 'null'] },
      secretId: { type: ['string', 'null'] },
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
          'ingress path. Present on GET /repositories/{id} only, and only for github / gitlab ' +
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
  RepositoriesResponse: {
    type: 'object',
    required: ['repositories'],
    properties: {
      repositories: {
        type: 'array',
        items: { $ref: '#/components/schemas/RepositoryRecord' },
      },
    },
  },
  CreateRepositoryBody: {
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
          'ssh:// or git@host:path when secretId is set.',
      },
      connectionId: {
        type: ['string', 'null'],
        description:
          'Required for provider=github. For provider=gitlab, supply exactly one of ' +
          'connectionId (the OAuth connection) or secretId (a generated deploy key); ' +
          'both together is rejected as source_auth_ambiguous.',
      },
      secretId: {
        type: ['string', 'null'],
        description:
          'Deploy key from POST /repositories/gitlab/deploy-keys. Not supported for provider=github.',
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
  PatchRepositoryBody: {
    type: 'object',
    description:
      'Scope (serviceId / environmentId) and provider are immutable — recreate the source to rebind.',
    properties: {
      connectionId: { type: ['string', 'null'] },
      secretId: { type: ['string', 'null'] },
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
  GitProviderConnectionRecord: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      organizationId: { type: 'string' },
      forgeId: {
        type: 'string',
        description:
          'The registered app this connection was granted through. The console groups connections by this id in the app → account → repository picker.',
      },
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
  GitProviderConnectionsResponse: {
    type: 'object',
    required: ['connections'],
    properties: {
      connections: {
        type: 'array',
        items: { $ref: '#/components/schemas/GitProviderConnectionRecord' },
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
    required: ['ok', 'secretId', 'publicKey', 'fingerprint'],
    properties: {
      ok: { type: 'boolean' },
      secretId: {
        type: 'string',
        description: 'Pass as secretId when creating the gitlab source.',
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
  plural: 'repositories',
  singular: 'repository',
  tag: 'Repositories',
  listSchema: 'RepositoriesResponse',
  rowSchema: 'RepositoryRecord',
  createSchema: 'CreateRepositoryBody',
  patchSchema: 'PatchRepositoryBody',
})

const repositoriesBasePath = '/api/client/v1/repositories'
const repositoryIdPath = `${repositoriesBasePath}/{id}`
const security = [{ cookieAuth: [] }]

const gitAppsBasePath = '/api/client/v1/forges'

export const repositoryPaths = {
  ...basePaths,
  [gitAppsBasePath]: {
    get: {
      tags: ['Repositories'],
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
              schema: { $ref: '#/components/schemas/OrgForgesResponse' },
            },
          },
        },
        ...resourceErrorResponses({}),
      },
    },
    post: {
      tags: ['Repositories'],
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
            schema: { $ref: '#/components/schemas/CreateOrgForgeBody' },
          },
        },
      },
      responses: {
        '201': {
          description: 'The registered application',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrgForgeResponse' },
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
      tags: ['Repositories'],
      summary: 'Read one Git application',
      security,
      responses: {
        '200': {
          description: 'The application',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrgForgeResponse' },
            },
          },
        },
        ...resourceErrorResponses({}),
      },
    },
    patch: {
      tags: ['Repositories'],
      summary: 'Update one Git application owned by this organization',
      security,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/PatchOrgForgeBody' },
          },
        },
      },
      responses: {
        '200': {
          description: 'The updated application',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrgForgeResponse' },
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
      tags: ['Repositories'],
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
  [`${repositoriesBasePath}/attach`]: {
    post: {
      tags: ['Repositories'],
      summary: 'Bind a repository to this organization, reusing an existing binding',
      description:
        'Called when a repository is attached to a project. **Idempotent**: two ' +
        'projects on the same repository share one row rather than racing to ' +
        'make two, which matters because auto-deploy and the default branch ' +
        'live on the row and duplicates would let one repository hold two ' +
        'policies while a single push fanned out to both. Commits before the ' +
        'project save that references it, because an unknown sourceId fails the ' +
        'compose lint.',
      security,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['connectionId', 'repositoryExternalId', 'repositoryUrl'],
              properties: {
                connectionId: { type: 'string', format: 'uuid' },
                repositoryExternalId: {
                  type: 'string',
                  description: 'Provider-side repository id — what webhook matching keys on',
                },
                repositoryUrl: { type: 'string' },
                defaultBranch: {
                  type: ['string', 'null'],
                  description: "Omit for the repository's own default",
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'An existing binding was reused',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  id: { type: 'string' },
                  reused: { type: 'boolean' },
                },
              },
            },
          },
        },
        '201': {
          description: 'A new binding was created',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  id: { type: 'string' },
                  reused: { type: 'boolean' },
                },
              },
            },
          },
        },
        '400': {
          description: 'Malformed body',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        ...resourceErrorResponses({}),
      },
    },
  },
  [`${gitAppsBasePath}/{id}/sync`]: {
    post: {
      tags: ['Repositories'],
      summary: "Reconcile an app against the provider's own record of it",
      description:
        'Reads `GET /app` with the App JWT and updates the stored name, slug, ' +
        'app id and visibility. An operator can rename an App on GitHub and ' +
        'nothing announces it — and a stale slug is not cosmetic, it builds the ' +
        'install URL, so a renamed App silently loses the ability to connect ' +
        'new accounts. GitHub apps only: a GitLab OAuth application has no ' +
        'equivalent self-describing endpoint.',
      security,
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'The reconciled app, plus the provider permission/event sets',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  app: { $ref: '#/components/schemas/OrgForge' },
                  provider: {
                    type: 'object',
                    description:
                      'What GitHub currently holds. Reported, not judged — ' +
                      'what counts as drift is a product question.',
                    properties: {
                      permissions: { type: 'object' },
                      events: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
        '400': {
          description: 'git_app_sync_unsupported — not a GitHub app',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '403': {
          description: 'git_app_not_writable — the application is instance-wide',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '502': {
          description:
            'git_app_sync_failed — GitHub refused. A 401 from GitHub means the ' +
            'stored private key no longer matches the App.',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        ...resourceErrorResponses({}),
      },
    },
  },
  [`${gitAppsBasePath}/github/manifest`]: {
    post: {
      tags: ['Repositories'],
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
      tags: ['Repositories'],
      summary: 'Finish the GitHub App Manifest flow',
      description:
        "Exchanges GitHub's one-shot code for the App credentials and stores " +
        'them, then 302s the operator\'s browser back to the Git providers ' +
        'page. The organization is pinned in the query string rather than the ' +
        'usual header because this is a top-level navigation.',
      security,
      parameters: [
        { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '302': {
          description:
            'Redirect to /{organizationId}/projects/git-apps with created= ' +
            'or error=',
        },
        ...resourceErrorResponses({}),
      },
    },
  },
  [repositoriesBasePath]: {
    ...(basePaths[repositoriesBasePath] as Record<string, unknown>),
    get: {
      ...((basePaths[repositoriesBasePath] as Record<string, unknown>).get as Record<
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
  [repositoryIdPath]: {
    ...(basePaths[repositoryIdPath] as Record<string, unknown>),
    delete: {
      ...((basePaths[repositoryIdPath] as Record<string, unknown>).delete as Record<
        string,
        unknown
      >),
      responses: {
        ...(((basePaths[repositoryIdPath] as Record<string, unknown>).delete as Record<
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
  [`${repositoriesBasePath}/connections`]: {
    get: {
      tags: ['Repositories'],
      summary: 'List Git provider App installations',
      description: 'Reads persisted installation rows only — no live provider call.',
      security,
      responses: {
        '200': {
          description: 'Installations granted to the signed-in organization',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/GitProviderConnectionsResponse' },
            },
          },
        },
        ...resourceErrorResponses({}),
      },
    },
  },
  [`${repositoriesBasePath}/connections/{id}/repositories`]: {
    get: {
      tags: ['Repositories'],
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
  [`${repositoriesBasePath}/github/install`]: {
    get: {
      tags: ['Repositories'],
      summary: 'Start the GitHub App installation flow',
      description:
        'Redirects to GitHub with a signed `state` binding the flow to the caller ' +
        'organization **and** to the chosen application.',
      security,
      parameters: [
        {
          name: 'forgeId',
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
          description: 'git_app_required — no usable forgeId was supplied',
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
  [`${repositoriesBasePath}/github/callback`]: {
    get: {
      tags: ['Repositories'],
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
  [`${repositoriesBasePath}/gitlab/oauth`]: {
    get: {
      tags: ['Repositories'],
      summary: 'Start the GitLab OAuth connect flow',
      description:
        'Redirects to the GitLab authorize endpoint with a signed `state` binding the flow ' +
        "to the caller organization and to the chosen application. GitLab has no " +
        'App install, so this connects one account or group rather than selecting ' +
        'repositories.',
      security,
      parameters: [
        {
          name: 'forgeId',
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
          description: 'git_app_required — no usable forgeId was supplied',
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
  [`${repositoriesBasePath}/gitlab/oauth/callback`]: {
    get: {
      tags: ['Repositories'],
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
  [`${repositoriesBasePath}/gitlab/deploy-keys`]: {
    post: {
      tags: ['Repositories'],
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
