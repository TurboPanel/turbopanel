/**
 * One delivery attempt per channel kind — the bodies a webhook, Slack,
 * Discord or Telegram expect, and the contract every sender keeps:
 *
 * - **Never rejects.** A sender resolves to `{ ok }` or `{ ok: false, error }`;
 *   a thrown error is a bug. The emitter's job is to record what happened,
 *   never to fail because a chat service is down (the contract
 *   `alert-sender.ts` had, kept verbatim).
 * - **Bounded.** Every attempt is abandoned after {@link SEND_TIMEOUT_MS}.
 * - **The address is a credential.** Errors carry an HTTP status or a short
 *   code, never the URL, never a response body.
 *
 * Workers-bundle safe: `fetch` and `crypto.subtle` are reached for at call
 * time, never at module load.
 */
import type { DeliveryPayload } from "./records.ts";

export const SEND_TIMEOUT_MS = 5_000;

export type SendOutcome = { ok: true } | { ok: false; error: string };

export type SendTarget = {
  kind: "webhook" | "slack" | "discord" | "telegram" | "push" | "email";
  /** Plain (unsealed) address. */
  address: string;
  /** Plain signing secret for the generic webhook kind. */
  signingSecret?: string | null;
};

/** The context as sorted `key=value` lines, nulls dropped — what an email lists and a chat line appends. */
export function renderDetails(payload: DeliveryPayload): string[] {
  return Object.keys(payload.context)
    .sort((a, b) => a.localeCompare(b))
    .filter((key) =>
      payload.context[key] !== undefined && payload.context[key] !== null
    )
    .map((key) => `${key}=${payload.context[key]}`);
}

/** The line every chat-style receiver shows: the title, then the context as `key=value`. */
export function renderText(payload: DeliveryPayload): string {
  const parts = renderDetails(payload);
  const head = payload.body
    ? `${payload.title} — ${payload.body}`
    : payload.title;
  return parts.length > 0 ? `${head} (${parts.join(" ")})` : head;
}

/** The generic JSON body: everything a receiver could want, nothing secret. */
export function webhookBody(payload: DeliveryPayload): Record<string, unknown> {
  return {
    event: payload.event,
    severity: payload.severity,
    title: payload.title,
    body: payload.body,
    text: renderText(payload),
    organizationId: payload.organizationId,
    target: payload.targetType
      ? { type: payload.targetType, id: payload.targetId }
      : null,
    context: payload.context,
    at: payload.at,
  };
}

/** Slack, Mattermost, Rocket.Chat and Discord all read `text` / `content`. */
export function chatBody(
  kind: "slack" | "discord",
  payload: DeliveryPayload,
): Record<string, unknown> {
  const text = renderText(payload);
  return kind === "discord" ? { content: text } : { text };
}

export function telegramBody(
  chatId: string,
  payload: DeliveryPayload,
): Record<string, unknown> {
  return {
    chat_id: chatId,
    text: renderText(payload),
    disable_web_page_preview: true,
  };
}

const encoder = new TextEncoder();

/** `sha256=<hex>` over the raw body — what `X-TurboPanel-Signature` carries. */
export async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(body)),
  );
  let hex = "";
  for (const byte of mac) hex += byte.toString(16).padStart(2, "0");
  return `sha256=${hex}`;
}

/**
 * A Telegram channel's address is one sealed string, `<bot token>/<chat id>`
 * (an optional `bot` prefix on the token is tolerated): the token is the
 * credential and the chat id the destination, and keeping them together means
 * one column, one seal, one thing to rotate.
 */
export function parseTelegramAddress(
  address: string,
): { token: string; chatId: string } | null {
  const slash = address.lastIndexOf("/");
  if (slash <= 0) return null;
  const token = address.slice(0, slash).replace(/^bot/, "");
  const chatId = address.slice(slash + 1);
  if (!token || !chatId) return null;
  return { token, chatId };
}

async function post(
  url: string,
  body: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<SendOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: controller.signal,
    });
    // Drain so the connection can be reused rather than hang.
    await response.text().catch(() => undefined);
    return response.ok
      ? { ok: true }
      : { ok: false, error: `http_${response.status}` };
  } catch (error) {
    const name = error instanceof Error ? error.name : "error";
    return { ok: false, error: name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** Deliver one payload to one target. Resolves always; see the module contract. */
export async function send(
  target: SendTarget,
  payload: DeliveryPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<SendOutcome> {
  try {
    switch (target.kind) {
      case "webhook": {
        const body = JSON.stringify(webhookBody(payload));
        const headers: Record<string, string> = {
          "x-turbopanel-event": payload.event,
          "user-agent": "TurboPanel-Notifications/1",
        };
        if (target.signingSecret) {
          headers["x-turbopanel-signature"] = await signBody(
            target.signingSecret,
            body,
          );
        }
        return await post(target.address, body, headers, fetchImpl);
      }
      case "slack":
      case "discord":
        return await post(
          target.address,
          JSON.stringify(chatBody(target.kind, payload)),
          {},
          fetchImpl,
        );
      case "telegram": {
        const parsed = parseTelegramAddress(target.address);
        if (!parsed) return { ok: false, error: "address_invalid" };
        return await post(
          `https://api.telegram.org/bot${parsed.token}/sendMessage`,
          JSON.stringify(telegramBody(parsed.chatId, payload)),
          {},
          fetchImpl,
        );
      }
      case "email":
      case "push":
        // Email rides the mailer queue and push the Expo service — neither is
        // a plain POST from here. The emitter routes them elsewhere; reaching
        // this arm is a wiring error, reported as such rather than thrown.
        return { ok: false, error: `unsupported_${target.kind}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : "error" };
  }
}
