/**
 * Retry a safe request once when its database connection dropped mid-flight.
 *
 * A primary restart or a failover drops the connections it is holding, and the
 * Workers runtime opens a fresh client per request — so the only request that
 * can see it is the one in flight. Hono never lets a handler's throw escape
 * `app.fetch` (its error handler turns it into a 500 first), so the loss has to
 * be noticed in `onError`, not in a `catch` around `fetch`.
 *
 * Only GET and HEAD are replayed: a GET that failed mid-flight has changed
 * nothing, while replaying a POST could double a write. Everything else keeps
 * Hono's default error response.
 */
import type { Context, Env, Hono } from "hono";
import { isConnectionClosedError } from "../../db/connection.ts";

type ErrorWithResponse = Error & { getResponse: () => Response };

function hasResponse(err: Error): err is ErrorWithResponse {
  return typeof (err as Partial<ErrorWithResponse>).getResponse === "function";
}

/** Hono's own default error response, kept for everything this module does not retry. */
function defaultErrorResponse(err: Error, c: Context): Response {
  if (hasResponse(err)) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
}

export type ConnectionRetryOptions = {
  /** Open a fresh database connection for the replay (the old one is gone). */
  reopen: () => void;
  /** Told once when a request is replayed. */
  onRetry?: (method: string, path: string) => void;
};

/**
 * Serve `request` through `app`, replaying it once on a fresh connection when
 * a GET/HEAD handler failed with a connection-closed error. Installs its own
 * `onError` on `app`, so call it with a per-request app.
 */
export async function fetchWithConnectionRetry<E extends Env>(
  app: Hono<E>,
  request: Request,
  env: unknown,
  ctx: unknown,
  opts: ConnectionRetryOptions,
): Promise<Response> {
  let connectionLost = false;
  app.onError((err, c) => {
    if (isConnectionClosedError(err)) connectionLost = true;
    return defaultErrorResponse(err, c);
  });

  const call = () =>
    app.fetch(
      request,
      env as E["Bindings"],
      ctx as Parameters<Hono<E>["fetch"]>[2],
    );
  const first = await call();
  const method = request.method.toUpperCase();
  if (!connectionLost || (method !== "GET" && method !== "HEAD")) return first;

  opts.onRetry?.(method, new URL(request.url).pathname);
  opts.reopen();
  connectionLost = false;
  // The same request object: GET/HEAD carry no body to have consumed.
  return await call();
}
