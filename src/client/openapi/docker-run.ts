export const dockerRunSchemas = {
  DockerRunDiagnostic: {
    type: 'object',
    required: ['code', 'message', 'blocking'],
    properties: {
      code: {
        type: 'string',
        enum: [
          'unknown_option',
          'missing_option_value',
          'unexpected_option_value',
          'missing_image',
          'option_not_repeatable',
          'operational_option_ignored',
          'option_unsupported',
          'option_value_unparsed',
          'shell_syntax_literal',
        ],
        description:
          'Machine-readable finding. `operational_option_ignored` names a flag that describes the CLI invocation rather than the container (`-d`, `-it`, `--cidfile`) and is never blocking; `option_unsupported` names one TurboPanel has no behavior for.',
      },
      flag: {
        type: 'string',
        description: 'The flag exactly as authored (`-v`, not `--volume`).',
      },
      message: { type: 'string' },
      blocking: {
        type: 'boolean',
        description:
          'When true the import is refused with **422** `docker_run_unsupported`. There is no override: fix the command and re-send it.',
      },
    },
  },
  DockerRunRiskFlag: {
    type: 'object',
    required: ['kind', 'source', 'message'],
    properties: {
      kind: {
        type: 'string',
        enum: [
          'privileged',
          'capability_add',
          'device_passthrough',
          'device_cgroup_rule',
          'pid_namespace',
          'ipc_namespace',
          'host_network',
          'user_namespace',
          'cgroup_namespace',
          'security_option',
          'docker_api_socket',
          'host_bind_mount',
        ],
        description:
          'Class of blast-radius widening the imported flag introduces. `host_bind_mount` and `docker_api_socket` are raised from the *value* (a `-v` whose source is a host path), not from the flag alone.',
      },
      source: {
        type: 'string',
        description: 'The flag and value that raised it, exactly as authored.',
      },
      message: {
        type: 'string',
        description: 'Why it matters — render verbatim; do not summarize.',
      },
    },
  },
  DockerRunImportRequest: {
    type: 'object',
    required: ['serviceName', 'argv'],
    properties: {
      serviceName: {
        type: 'string',
        maxLength: 63,
        pattern: '^[a-zA-Z0-9._-]+$',
        description: 'Compose `services.<name>` key the container becomes.',
      },
      argv: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
        description:
          'A pasted command line or an argv array, with or without a leading `[sudo] docker [container] run` — only that complete prefix is stripped, so an image genuinely named `run` or `docker` survives. The string form is tokenized by a lexer, never by a shell: quotes and backslash escapes are honoured, and command substitution, pipelines, redirection and globs are carried through as literal characters with a non-blocking diagnostic.',
      },
      projectId: {
        type: 'string',
        description:
          'Optional. When supplied the project is resolved in the caller\'s organization and gated at the same create-level bar as authoring compose for it; omit it for a pure parse.',
      },
    },
  },
  DockerRunImportResponse: {
    type: 'object',
    required: [
      'ok',
      'compose',
      'image',
      'command',
      'diagnostics',
      'riskFlags',
      'composeIssues',
    ],
    properties: {
      ok: { type: 'boolean', const: true },
      compose: {
        type: 'object',
        description:
          'A one-service `ComposeDocument` (`version: 1`, `data`, `presentation`) in standard Compose vocabulary. Nothing is written under `x-turbopanel`, and the original command is not persisted anywhere. Merge it into your draft and save it through the ordinary project/environment compose PATCH — this route writes nothing.',
        additionalProperties: true,
      },
      image: {
        type: ['string', 'null'],
        description: 'The IMAGE that was read, echoed back.',
      },
      command: {
        type: 'array',
        items: { type: 'string' },
        description: 'COMMAND [ARG...] after the image.',
      },
      diagnostics: {
        type: 'array',
        items: { $ref: '#/components/schemas/DockerRunDiagnostic' },
      },
      riskFlags: {
        type: 'array',
        description:
          'How the imported container\'s blast radius widens. Returned only on a successful import — show every entry to the operator, and gate the merge on whatever authorization your policy requires, before the fragment is saved.',
        items: { $ref: '#/components/schemas/DockerRunRiskFlag' },
      },
      composeIssues: {
        type: 'array',
        description:
          'What the compiled fragment would hit on save, from the same validator and linter the compose PATCH runs, at their permissive posture.',
        items: {
          type: 'object',
          required: ['path', 'message'],
          properties: {
            path: { type: 'string' },
            message: { type: 'string' },
            level: { type: 'string', enum: ['error', 'warning'] },
            line: { type: 'integer' },
          },
        },
      },
    },
  },
  DockerRunUnsupportedError: {
    type: 'object',
    required: ['error', 'diagnostics'],
    properties: {
      error: { type: 'string', const: 'docker_run_unsupported' },
      diagnostics: {
        type: 'array',
        items: { $ref: '#/components/schemas/DockerRunDiagnostic' },
      },
    },
  },
}

export const dockerRunPaths = {
  '/api/client/v1/docker-run/import': {
    post: {
      tags: ['Docker run import'],
      summary: 'Translate a docker run command into a compose fragment',
      description:
        'Parses `docker container run [OPTIONS] IMAGE [COMMAND] [ARG...]` against a registry of every option Docker ships and returns a single-service compose fragment plus the findings the operator has to see before merging it. Nothing is executed and nothing is persisted: the command is tokenized by a lexer rather than a shell, and the response is compute only.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/DockerRunImportRequest' },
          },
        },
      },
      responses: {
        200: {
          description: 'Compose fragment, diagnostics, and risk flags',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DockerRunImportResponse' },
            },
          },
        },
        400: {
          description: 'Malformed body, or a service name that is not a Compose key',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        404: {
          description: '`projectId` is not in the caller\'s organization',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        422: {
          description:
            '`docker_run_unsupported` — at least one blocking diagnostic (an unknown flag, a flag TurboPanel does not implement such as `--rm` / `-P` / the Windows-only resource flags, or a command with no image). Unconditional: there is no acknowledgement that turns this into a success, because a fragment with those flags dropped no longer means what was pasted. The partial fragment is not returned; fix the command and re-send it.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DockerRunUnsupportedError' },
            },
          },
        },
      },
    },
  },
}
