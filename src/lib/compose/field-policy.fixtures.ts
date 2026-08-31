/**
 * Shared field-policy lint fixtures.
 *
 * **This file is byte-identical in both repositories** —
 * `turbopanel/src/lib/compose/field-policy.fixtures.ts` and
 * `ui/src/lib/compose/field-policy.fixtures.ts`, which is why `diff` over the
 * two is the drift check.
 * They ship separately and cannot import across the boundary,
 * so the copies are kept in step by convention: change one, change the other in
 * the same commit, and a reviewer diffing the two files sees drift immediately.
 * That drift is the failure mode worth guarding — the UI linter is a hand-
 * mirrored copy of the control-plane linter, and the way it goes wrong is that
 * the editor blesses a document the server then refuses (or the reverse), which
 * is the one thing a linter must never do.
 *
 * Each case is a whole compose document plus the issues the linter is expected
 * to raise. `strictLevel` is the severity the same finding takes on when the
 * caller asks for deploy-time strictness; the control plane exercises both
 * postures, and the UI — which has no deploy-time mode, since deploys are
 * server-validated — asserts the permissive column only.
 */

export type FieldPolicyExpectedIssue = {
  /** Dot-joined compose path the issue must be reported at. */
  path: string
  /** Substring the message must contain. Full text stays free to improve. */
  messageIncludes: string
  /** Severity when the linter runs permissively (save-time). */
  level: 'error' | 'warning'
  /** Whether the permissive run treats it as blocking. */
  blocking: boolean
  /**
   * Severity when the linter runs strictly (deploy-time). Absent means the
   * posture makes no difference to this issue.
   */
  strictLevel?: 'error' | 'warning'
}

export type FieldPolicyFixture = {
  description: string
  compose: string
  expectedIssues: FieldPolicyExpectedIssue[]
}

export const FIELD_POLICY_FIXTURES: readonly FieldPolicyFixture[] = [
  {
    description: 'a fully valid document raises nothing',
    compose: `services:
  web:
    image: nginx:alpine
    deploy:
      replicas: 2
      resources:
        limits:
          cpus: "0.5"
`,
    expectedIssues: [],
  },
  {
    description: 'unknown top-level key is a suggestion, not a schema dump',
    compose: `servces:
  web:
    image: nginx:alpine
services:
  web:
    image: nginx:alpine
`,
    expectedIssues: [
      {
        path: 'servces',
        messageIncludes: 'did you mean "services"',
        level: 'warning',
        blocking: true,
      },
    ],
  },
  {
    description: 'unknown service key is a suggestion, not a schema dump',
    compose: `services:
  web:
    imaage: nginx:alpine
    image: nginx:alpine
`,
    expectedIssues: [
      {
        path: 'services.web.imaage',
        messageIncludes: 'did you mean "image"',
        level: 'warning',
        blocking: true,
      },
    ],
  },
  {
    description:
      'deploy.update_config is unsupported: advice while editing, refusal at deploy',
    compose: `services:
  web:
    image: nginx:alpine
    deploy:
      update_config:
        parallelism: 2
`,
    expectedIssues: [
      {
        path: 'services.web.deploy.update_config',
        messageIncludes: 'not supported by TurboPanel',
        level: 'warning',
        blocking: false,
        strictLevel: 'error',
      },
    ],
  },
  {
    description: 'deploy.rollback_config and deploy.endpoint_mode too',
    compose: `services:
  web:
    image: nginx:alpine
    deploy:
      endpoint_mode: dnsrr
      rollback_config:
        parallelism: 1
`,
    expectedIssues: [
      {
        path: 'services.web.deploy.endpoint_mode',
        messageIncludes: 'not supported by TurboPanel',
        level: 'warning',
        blocking: false,
        strictLevel: 'error',
      },
      {
        path: 'services.web.deploy.rollback_config',
        messageIncludes: 'not supported by TurboPanel',
        level: 'warning',
        blocking: false,
        strictLevel: 'error',
      },
    ],
  },
  {
    description:
      'deploy.mode: replicated-job is refused by value, not by stripping the key',
    compose: `services:
  worker:
    image: nginx:alpine
    deploy:
      mode: replicated-job
`,
    expectedIssues: [
      {
        path: 'services.worker.deploy.mode',
        messageIncludes: 'not supported by TurboPanel',
        level: 'warning',
        blocking: false,
        strictLevel: 'error',
      },
    ],
  },
  {
    description: 'deploy.mode: global-job is refused the same way',
    compose: `services:
  worker:
    image: nginx:alpine
    deploy:
      mode: global-job
`,
    expectedIssues: [
      {
        path: 'services.worker.deploy.mode',
        messageIncludes: 'finite-job controller',
        level: 'warning',
        blocking: false,
        strictLevel: 'error',
      },
    ],
  },
  {
    description: 'deploy.mode: global is a mode TurboPanel schedules — no issue',
    compose: `services:
  agent:
    image: nginx:alpine
    deploy:
      mode: global
`,
    expectedIssues: [],
  },
  {
    description:
      'deploy.resources.reservations is unsupported even though resources is not',
    compose: `services:
  web:
    image: nginx:alpine
    deploy:
      resources:
        limits:
          cpus: "2"
        reservations:
          cpus: "0.5"
          memory: 512M
`,
    expectedIssues: [
      {
        path: 'services.web.deploy.resources.reservations',
        messageIncludes: 'no per-host capacity inventory',
        level: 'warning',
        blocking: false,
        strictLevel: 'error',
      },
    ],
  },
  {
    description:
      'a bridge network keeps every attribute — the registry has no opinion',
    compose: `services:
  web:
    image: nginx:alpine
    networks:
      - frontend
networks:
  frontend:
    driver: bridge
    attachable: true
    enable_ipv6: true
    ipam:
      config:
        - subnet: 172.28.0.0/16
    driver_opts:
      com.docker.network.bridge.name: br-front
`,
    expectedIssues: [],
  },
  {
    description:
      'driver: overlay is the authored spanning signal and carries a note',
    compose: `services:
  web:
    image: nginx:alpine
    networks:
      - frontend
networks:
  frontend:
    driver: overlay
    labels:
      com.example.team: platform
`,
    expectedIssues: [
      {
        path: 'networks.frontend.driver',
        messageIncludes: 'TurboFabric spanning network',
        level: 'warning',
        blocking: false,
      },
    ],
  },
  {
    description:
      'the five overlay-only attributes TurboFabric cannot honour are named',
    compose: `services:
  web:
    image: nginx:alpine
    networks:
      - frontend
networks:
  frontend:
    driver: overlay
    attachable: true
    enable_ipv6: true
    ipam:
      config:
        - subnet: 172.28.0.0/16
    driver_opts:
      com.docker.network.driver.mtu: "1400"
    internal: true
`,
    expectedIssues: [
      {
        path: 'networks.frontend.driver',
        messageIncludes: 'TurboFabric spanning network',
        level: 'warning',
        blocking: false,
      },
      {
        path: 'networks.frontend.attachable',
        messageIncludes: 'Swarm service-network flag',
        level: 'warning',
        blocking: false,
        strictLevel: 'error',
      },
      {
        path: 'networks.frontend.enable_ipv6',
        messageIncludes: 'IPv4-only',
        level: 'warning',
        blocking: false,
        strictLevel: 'error',
      },
      {
        path: 'networks.frontend.ipam',
        messageIncludes: 'one subnet per participating host',
        level: 'warning',
        blocking: false,
        strictLevel: 'error',
      },
      {
        path: 'networks.frontend.driver_opts',
        messageIncludes: 'routed bridge on each host',
        level: 'warning',
        blocking: false,
        strictLevel: 'error',
      },
      {
        path: 'networks.frontend.internal',
        messageIncludes: 'an internal network forbids',
        level: 'warning',
        blocking: false,
        strictLevel: 'error',
      },
    ],
  },
  {
    description: 'deploy.labels is interpreted — no issue at either posture',
    compose: `services:
  web:
    image: nginx:alpine
    deploy:
      labels:
        com.example.team: platform
      restart_policy:
        condition: on-failure
`,
    expectedIssues: [],
  },
] as const
