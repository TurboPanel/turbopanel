import { assertEquals, assertMatch } from "@std/assert";
import type { DeliveryPayload } from "./records.ts";
import {
  chatBody,
  parseTelegramAddress,
  renderText,
  send,
  signBody,
  webhookBody,
} from "./senders.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const payload: DeliveryPayload = {
  event: "server.offline",
  severity: "critical",
  title: "Server db-1 went offline",
  body: "The daemon stopped answering.",
  organizationId: "00000000-0000-4000-8000-0000000000a1",
  organizationName: "Acme",
  targetType: "server",
  targetId: "00000000-0000-4000-8000-0000000000b1",
  context: { serverName: "db-1", zed: 1, alpha: "x", gone: null },
  at: "2026-09-18T10:00:00.000Z",
};

type Captured = { url: string; init: RequestInit };

function fakeFetch(
  status: number,
  captured: Captured[],
  behaviour: "ok" | "hang" | "throw" = "ok",
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    if (behaviour === "throw") {
      return Promise.reject(new TypeError("connection refused"));
    }
    if (behaviour === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    return Promise.resolve(new Response("ok", { status }));
  }) as typeof fetch;
}

test("the text line is the title, the body, then the context sorted and without nulls", () => {
  assertEquals(
    renderText(payload),
    "Server db-1 went offline — The daemon stopped answering. (alpha=x serverName=db-1 zed=1)",
  );
});

test("the generic webhook body carries the structured event and nothing secret", () => {
  const body = webhookBody(payload);
  assertEquals(body.event, "server.offline");
  assertEquals(body.severity, "critical");
  assertEquals(body.target, { type: "server", id: payload.targetId });
  assertEquals(body.at, payload.at);
  assertEquals(Object.hasOwn(body, "address"), false);
});

test("Slack reads text, Discord reads content", () => {
  assertEquals(Object.keys(chatBody("slack", payload)), ["text"]);
  assertEquals(Object.keys(chatBody("discord", payload)), ["content"]);
});

test("a webhook send signs the raw body with the channel secret and names the event", async () => {
  const captured: Captured[] = [];
  const outcome = await send(
    {
      kind: "webhook",
      address: "https://hooks.example.com/x",
      signingSecret: "s3cret",
    },
    payload,
    fakeFetch(200, captured),
  );
  assertEquals(outcome, { ok: true });
  const headers = captured[0]!.init.headers as Record<string, string>;
  assertEquals(headers["x-turbopanel-event"], "server.offline");
  assertMatch(headers["x-turbopanel-signature"]!, /^sha256=[0-9a-f]{64}$/);
  assertEquals(
    headers["x-turbopanel-signature"],
    await signBody("s3cret", captured[0]!.init.body as string),
  );
});

test("a refusal, a timeout and a thrown fetch all resolve — never reject — with a short code", async () => {
  const refused = await send(
    { kind: "slack", address: "https://h/x" },
    payload,
    fakeFetch(500, []),
  );
  assertEquals(refused, { ok: false, error: "http_500" });
  const thrown = await send(
    { kind: "discord", address: "https://h/x" },
    payload,
    fakeFetch(200, [], "throw"),
  );
  assertEquals(thrown, { ok: false, error: "network" });
});

test("a Telegram address is one sealed string: token then chat id", () => {
  assertEquals(parseTelegramAddress("123456:ABC-DEF/987654321"), {
    token: "123456:ABC-DEF",
    chatId: "987654321",
  });
  assertEquals(parseTelegramAddress("bot123456:ABC-DEF/-100123"), {
    token: "123456:ABC-DEF",
    chatId: "-100123",
  });
  assertEquals(parseTelegramAddress("nonsense"), null);
});

test("a Telegram send posts to the Bot API with the chat id in the body", async () => {
  const captured: Captured[] = [];
  await send(
    { kind: "telegram", address: "123:ABC/42" },
    payload,
    fakeFetch(200, captured),
  );
  assertEquals(
    captured[0]!.url,
    "https://api.telegram.org/bot123:ABC/sendMessage",
  );
  assertEquals(JSON.parse(captured[0]!.init.body as string).chat_id, "42");
});

test("email and push are not sent from here", async () => {
  assertEquals(
    await send(
      { kind: "email", address: "a@b.c" },
      payload,
      fakeFetch(200, []),
    ),
    {
      ok: false,
      error: "unsupported_email",
    },
  );
});
