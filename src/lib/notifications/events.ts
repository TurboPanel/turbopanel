/**
 * The event catalogue — everything the platform can notify about, in one
 * enumerated vocabulary.
 *
 * An event has a stable code (the thing a subscription rule names and a
 * `notification` row stores — CHECK-pinned, per the 2026-09-11 decision), a
 * severity, the scope it belongs to, and one function that turns its small
 * non-secret context into the sentence a human reads. Nothing here knows how
 * a sentence is delivered; `emit.ts` fans it out and the channel senders
 * carry it.
 *
 * Only events with an emitter are listed. An entry nobody emits is a promise
 * the console cannot keep, so an event joins this list in the same commit as
 * the code that raises it. The two operator alerts the offline sweep already
 * raised (`server.offline`, `fleet.mass_disconnect`) are the seed; the
 * audit-trail actions that a teammate would want to hear about follow.
 *
 * Workers-bundle safe: no `@std/*`, nothing evaluated at module load beyond
 * constants.
 */

export const NOTIFICATION_SEVERITIES = ["info", "warning", "critical"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/** Where an event belongs: to one organization, or to the instance as a whole. */
export const NOTIFICATION_SCOPES = ["organization", "instance"] as const;
export type NotificationScope = (typeof NOTIFICATION_SCOPES)[number];

/** Small, non-secret facts an event carries. Rendered into the sentence and stored beside it. */
export type NotificationContext = Record<
  string,
  string | number | boolean | null | undefined
>;

type EventDefinition = {
  readonly severity: NotificationSeverity;
  readonly scope: NotificationScope;
  /** The short line the bell and the subject line show. */
  readonly title: (ctx: NotificationContext) => string;
  /** The fuller sentence, when the title alone is not enough. */
  readonly body?: (ctx: NotificationContext) => string;
};

function name(ctx: NotificationContext, key: string, fallback: string): string {
  const value = ctx[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * The catalogue. Keys are the codes; the object is `as const` so the code
 * union and the CHECK pin in `enum-checks.test.ts` derive from one place.
 */
export const NOTIFICATION_EVENT_DEFINITIONS = {
  "server.offline": {
    severity: "critical",
    scope: "organization",
    title: (ctx) => `Server ${name(ctx, "serverName", "unknown")} went offline`,
    body: (ctx) =>
      `The daemon on ${
        name(ctx, "serverName", "the server")
      } stopped answering and the server was marked offline${
        typeof ctx.lastSeenAt === "string"
          ? ` (last seen ${ctx.lastSeenAt})`
          : ""
      }.`,
  },
  "fleet.mass_disconnect": {
    severity: "critical",
    scope: "instance",
    title: (ctx) =>
      `${
        typeof ctx.count === "number" ? ctx.count : "Many"
      } servers went offline in one sweep`,
    body: () =>
      "A whole sweep lost its fleet at once — that is usually the control plane's own network or " +
      "a broker, not every host at the same time.",
  },
  "server.deleted": {
    severity: "info",
    scope: "organization",
    title: (ctx) => `Server ${name(ctx, "serverName", "unknown")} was deleted`,
    body: (ctx) =>
      `${name(ctx, "actorEmail", "An operator")} deleted the server.`,
  },
  "server.daemon_key_revoked": {
    severity: "warning",
    scope: "organization",
    title: (ctx) =>
      `Daemon key revoked on ${name(ctx, "serverName", "a server")}`,
    body: (ctx) =>
      `${
        name(ctx, "actorEmail", "An operator")
      } revoked the daemon key; the host cannot enrol again until the server is deleted and a rebuilt host enrols fresh.`,
  },
  "access.grant_created": {
    severity: "info",
    scope: "organization",
    title: (ctx) =>
      `Access granted: ${name(ctx, "permissionKey", "a permission")}`,
    body: (ctx) =>
      `${name(ctx, "actorEmail", "An owner")} granted ${
        name(ctx, "permissionKey", "a permission")
      } to ${name(ctx, "subjectKind", "a subject")} ${
        name(ctx, "subjectId", "")
      }`.trimEnd() + ".",
  },
  "access.grant_revoked": {
    severity: "warning",
    scope: "organization",
    title: (ctx) =>
      `Access revoked: ${name(ctx, "permissionKey", "a permission")}`,
    body: (ctx) =>
      `${name(ctx, "actorEmail", "An owner")} revoked ${
        name(ctx, "permissionKey", "a permission")
      } from ${name(ctx, "subjectKind", "a subject")} ${
        name(ctx, "subjectId", "")
      }`.trimEnd() + ".",
  },
} as const satisfies Record<string, EventDefinition>;

export type NotificationEvent = keyof typeof NOTIFICATION_EVENT_DEFINITIONS;

/** The codes, in catalogue order — what the CHECK constraint and the rules vocabulary pin. */
export const NOTIFICATION_EVENTS = Object.keys(
  NOTIFICATION_EVENT_DEFINITIONS,
) as readonly NotificationEvent[];

/** A rule may name one event, or every event. */
export const NOTIFICATION_RULE_ANY_EVENT = "*" as const;
export const NOTIFICATION_RULE_EVENTS = [
  NOTIFICATION_RULE_ANY_EVENT,
  ...NOTIFICATION_EVENTS,
] as const;

export function isNotificationEvent(value: string): value is NotificationEvent {
  return Object.hasOwn(NOTIFICATION_EVENT_DEFINITIONS, value);
}

export function eventSeverity(event: NotificationEvent): NotificationSeverity {
  return NOTIFICATION_EVENT_DEFINITIONS[event].severity;
}

export function eventScope(event: NotificationEvent): NotificationScope {
  return NOTIFICATION_EVENT_DEFINITIONS[event].scope;
}

/** The sentence(s) a human reads for one occurrence of an event. */
export function describeEvent(
  event: NotificationEvent,
  context: NotificationContext = {},
): { title: string; body: string | null } {
  const definition: EventDefinition = NOTIFICATION_EVENT_DEFINITIONS[event];
  return {
    title: definition.title(context),
    body: definition.body ? definition.body(context) : null,
  };
}

const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

/** True when `severity` is at least `floor` — how a rule's minimum severity is applied. */
export function severityAtLeast(
  severity: NotificationSeverity,
  floor: NotificationSeverity,
): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[floor];
}
