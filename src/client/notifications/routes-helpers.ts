/**
 * Body parsing for the notification routes — pure, so the shapes are tested
 * without a database. Refusals are `{ status, error, reason? }`, the error a
 * short code the console maps to a sentence.
 */
import { validateEmailAddress } from "../../lib/email/validate-address.ts";
import {
  resolveOutboundHostScope,
  validateOutboundUrl,
} from "../../lib/http/outbound-url.ts";
import {
  isNotificationEvent,
  NOTIFICATION_RULE_ANY_EVENT,
  NOTIFICATION_SEVERITIES,
  type NotificationSeverity,
} from "../../lib/notifications/events.ts";
import {
  NOTIFICATION_CHANNEL_KINDS,
  type NotificationChannelKind,
} from "../../lib/notifications/records.ts";
import { parseTelegramAddress } from "../../lib/notifications/senders.ts";

export type ChannelWriteRefusal = {
  ok: false;
  status: 400 | 422;
  error: string;
  reason?: string;
};

export type ChannelRule = { event: string; minSeverity: NotificationSeverity };

export type ChannelCreate = {
  scope: "user" | "organization";
  kind: Exclude<NotificationChannelKind, "push">;
  label: string;
  address: string;
  signingSecret: string | null;
  rules: ChannelRule[];
};

export type ChannelPatch = {
  label?: string;
  disabled?: boolean;
  rules?: ChannelRule[];
};

export const CHANNEL_LABEL_MAX = 80;
export const CHANNEL_ADDRESS_MAX = 2048;
export const CHANNEL_SIGNING_SECRET_MAX = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Control characters (C0 and DEL) have no place in a label. */
function hasControlCharacters(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function parseRulesBody(
  raw: unknown,
): { ok: true; value: ChannelRule[] } | ChannelWriteRefusal {
  if (!Array.isArray(raw)) {
    return { ok: false, status: 400, error: "rules_invalid" };
  }
  const seen = new Set<string>();
  const rules: ChannelRule[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.event !== "string") {
      return { ok: false, status: 400, error: "rules_invalid" };
    }
    if (
      item.event !== NOTIFICATION_RULE_ANY_EVENT &&
      !isNotificationEvent(item.event)
    ) {
      return {
        ok: false,
        status: 400,
        error: "rule_event_unknown",
        reason: item.event,
      };
    }
    const minSeverity = item.minSeverity ?? "info";
    if (
      typeof minSeverity !== "string" ||
      !(NOTIFICATION_SEVERITIES as readonly string[]).includes(minSeverity)
    ) {
      return { ok: false, status: 400, error: "rule_severity_invalid" };
    }
    if (seen.has(item.event)) continue;
    seen.add(item.event);
    rules.push({
      event: item.event,
      minSeverity: minSeverity as NotificationSeverity,
    });
  }
  return { ok: true, value: rules };
}

function parseLabel(raw: unknown): string | ChannelWriteRefusal {
  if (typeof raw !== "string") {
    return { ok: false, status: 400, error: "label_required" };
  }
  const label = raw.trim();
  if (
    label.length === 0 || label.length > CHANNEL_LABEL_MAX ||
    hasControlCharacters(label)
  ) {
    return { ok: false, status: 400, error: "label_invalid" };
  }
  return label;
}

/**
 * The address rule per kind. A URL kind goes through the outbound gate at
 * write time, with the runtime's private-target policy; Telegram is a
 * `<token>/<chat id>` pair and its host is always api.telegram.org.
 */
export async function validateChannelAddress(
  kind: ChannelCreate["kind"],
  raw: unknown,
  opts: { allowPrivateTargets: boolean },
): Promise<string | ChannelWriteRefusal> {
  if (typeof raw !== "string") {
    return { ok: false, status: 400, error: "address_required" };
  }
  const address = raw.trim();
  if (address.length === 0 || address.length > CHANNEL_ADDRESS_MAX) {
    return { ok: false, status: 400, error: "address_invalid" };
  }
  switch (kind) {
    case "email": {
      try {
        validateEmailAddress(address, "address");
      } catch {
        return { ok: false, status: 400, error: "address_invalid" };
      }
      return address;
    }
    case "telegram": {
      const parsed = parseTelegramAddress(address);
      if (!parsed || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(parsed.token)) {
        return { ok: false, status: 400, error: "address_invalid" };
      }
      return address;
    }
    case "webhook":
    case "slack":
    case "discord": {
      const gate = { allowPrivate: opts.allowPrivateTargets };
      const rejection = validateOutboundUrl(address, gate) ??
        await resolveOutboundHostScope(address, gate);
      if (rejection) {
        return {
          ok: false,
          status: 422,
          error: "address_rejected",
          reason: rejection,
        };
      }
      return address;
    }
  }
}

export async function parseChannelCreateBody(
  raw: unknown,
  opts: { allowPrivateTargets: boolean },
): Promise<{ ok: true; value: ChannelCreate } | ChannelWriteRefusal> {
  if (!isRecord(raw)) return { ok: false, status: 400, error: "body_invalid" };
  const scope = raw.scope ?? "user";
  if (scope !== "user" && scope !== "organization") {
    return { ok: false, status: 400, error: "scope_invalid" };
  }
  const kind = raw.kind;
  if (
    typeof kind !== "string" ||
    !(NOTIFICATION_CHANNEL_KINDS as readonly string[]).includes(kind) ||
    kind === "push"
  ) {
    // Push tokens are registered by the store apps on sign-in, never typed in.
    return { ok: false, status: 400, error: "kind_invalid" };
  }
  const label = parseLabel(raw.label);
  if (typeof label !== "string") return label;
  const address = await validateChannelAddress(
    kind as ChannelCreate["kind"],
    raw.address,
    opts,
  );
  if (typeof address !== "string") return address;
  let signingSecret: string | null = null;
  if (raw.signingSecret !== undefined && raw.signingSecret !== null) {
    if (kind !== "webhook") {
      return {
        ok: false,
        status: 400,
        error: "signing_secret_not_applicable",
      };
    }
    if (
      typeof raw.signingSecret !== "string" ||
      raw.signingSecret.length === 0 ||
      raw.signingSecret.length > CHANNEL_SIGNING_SECRET_MAX
    ) {
      return { ok: false, status: 400, error: "signing_secret_invalid" };
    }
    signingSecret = raw.signingSecret;
  }
  const rules = parseRulesBody(raw.rules ?? []);
  if (!rules.ok) return rules;
  return {
    ok: true,
    value: {
      scope,
      kind: kind as ChannelCreate["kind"],
      label,
      address,
      signingSecret,
      rules: rules.value,
    },
  };
}

export function parseChannelPatchBody(
  raw: unknown,
): { ok: true; value: ChannelPatch } | ChannelWriteRefusal {
  if (!isRecord(raw)) return { ok: false, status: 400, error: "body_invalid" };
  const patch: ChannelPatch = {};
  if (raw.label !== undefined) {
    const label = parseLabel(raw.label);
    if (typeof label !== "string") return label;
    patch.label = label;
  }
  if (raw.disabled !== undefined) {
    if (typeof raw.disabled !== "boolean") {
      return { ok: false, status: 400, error: "disabled_invalid" };
    }
    patch.disabled = raw.disabled;
  }
  if (raw.rules !== undefined) {
    const rules = parseRulesBody(raw.rules);
    if (!rules.ok) return rules;
    patch.rules = rules.value;
  }
  return { ok: true, value: patch };
}
