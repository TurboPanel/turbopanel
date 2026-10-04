/** OpenAPI for the PHP mode policy routes (`client/hostings/php-mode-routes.ts`). */

const PHP_MODE_ENUM = ['fastcgi', 'fpm', 'lsphp-detached', 'lsphp-attached']

const policyList = (description: string) => ({
  type: ['array', 'null'],
  items: { $ref: '#/components/schemas/PhpMode' },
  description,
})

export const phpModeSchemas = {
  PhpMode: {
    type: 'string',
    enum: PHP_MODE_ENUM,
    description:
      '`fastcgi` (php-cgi), `fpm` (php-fpm master per site), `lsphp-detached` or `lsphp-attached` (OpenLiteSpeed only).',
  },
  PhpModeEngineChoices: {
    type: 'object',
    description:
      'Per site engine (`caddy`, `nginx`, `apache`, `nginx+apache`, `openlitespeed`): the modes a site may pick under this policy and what a new PHP site gets. Caddy has none.',
    additionalProperties: {
      type: 'object',
      required: ['allowed', 'default'],
      properties: {
        allowed: { type: 'array', items: { $ref: '#/components/schemas/PhpMode' } },
        default: { oneOf: [{ $ref: '#/components/schemas/PhpMode' }, { type: 'null' }] },
      },
    },
  },
  PhpModePolicyUpdate: {
    type: 'object',
    required: ['phpModes'],
    properties: { phpModes: policyList('Modes to offer; `null` offers every mode again.') },
  },
  PhpModePolicyUpdateResponse: {
    type: 'object',
    required: ['ok', 'phpModes', 'affectedSites'],
    properties: {
      ok: { type: 'boolean', const: true },
      phpModes: policyList('The stored list; `null` means every mode is offered.'),
      affectedSites: {
        type: 'array',
        description:
          'Sites whose last deploy recorded a mode this policy no longer offers. They keep that mode until someone picks another.',
        items: {
          type: 'object',
          required: ['environmentId', 'serverId', 'composeServiceName', 'mode'],
          properties: {
            environmentId: { type: 'string', format: 'uuid' },
            serverId: { type: 'string', format: 'uuid' },
            composeServiceName: { type: 'string' },
            mode: { $ref: '#/components/schemas/PhpMode' },
          },
        },
      },
    },
  },
}

const json = (ref: string) => ({
  'application/json': { schema: { $ref: `#/components/schemas/${ref}` } },
})

const errorResponses = (notFound: string) => ({
  '401': { description: 'Unauthorized', content: json('ErrorResponse') },
  '403': {
    description: 'Not an owner or manager of the organization',
    content: json('ErrorResponse'),
  },
  '404': { description: notFound, content: json('ErrorResponse') },
})

function policyPath(params: {
  tag: string
  noun: string
  notFound: string
  readSchema: Record<string, unknown>
  readDescription: string
}) {
  const parameters = [
    { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
  ]
  return {
    get: {
      tags: [params.tag],
      summary: `Get the PHP modes this ${params.noun} offers`,
      description: params.readDescription,
      security: [{ cookieAuth: [] }],
      parameters,
      responses: {
        '200': {
          description: 'PHP mode policy',
          content: { 'application/json': { schema: params.readSchema } },
        },
        ...errorResponses(params.notFound),
      },
    },
    put: {
      tags: [params.tag],
      summary: `Set the PHP modes this ${params.noun} offers`,
      description:
        'Owners and managers only. Never changes a site: sites already running a mode the new list leaves out keep it, and are listed in `affectedSites`.',
      security: [{ cookieAuth: [] }],
      parameters,
      requestBody: { required: true, content: json('PhpModePolicyUpdate') },
      responses: {
        '200': { description: 'Policy stored', content: json('PhpModePolicyUpdateResponse') },
        '400': {
          description: '`invalid_php_modes`: not a list of known modes or null',
          content: json('ErrorResponse'),
        },
        ...errorResponses(params.notFound),
      },
    },
  }
}

export const phpModePaths: Record<string, unknown> = {
  '/api/client/v1/organizations/{id}/php-modes': policyPath({
    tag: 'Organizations',
    noun: 'organization',
    notFound: 'Organization not found',
    readDescription:
      'Owners and managers only. `phpModes` is the stored list (`null` offers every mode); `engines` says what a site on each engine may pick and gets by default (FastCGI, then php-fpm, then detached lsphp).',
    readSchema: {
      type: 'object',
      required: ['phpModes', 'engines'],
      properties: {
        phpModes: policyList('`null` means every mode is offered.'),
        engines: { $ref: '#/components/schemas/PhpModeEngineChoices' },
      },
    },
  }),
  '/api/client/v1/servers/{id}/php-modes': policyPath({
    tag: 'Servers',
    noun: 'server',
    notFound: 'Server not found in the caller organization',
    readDescription:
      'Owners and managers only. A site on this server may use a mode only when both lists and its engine allow it; `engines` is that intersection.',
    readSchema: {
      type: 'object',
      required: ['phpModes', 'organizationPhpModes', 'engines'],
      properties: {
        phpModes: policyList('This server; `null` means every mode is offered.'),
        organizationPhpModes: policyList('The organization; `null` means every mode is offered.'),
        engines: { $ref: '#/components/schemas/PhpModeEngineChoices' },
      },
    },
  }),
}
