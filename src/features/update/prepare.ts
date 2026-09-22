/**
 * Hook run before a queued daemon update envelope is released to a daemon.
 *
 * The dev instance registers a preparer that rebuilds the local daemon overlay
 * (`deno task release:dev`) when the checkout changed since the last build, so
 * daemons install the current local source (see
 * src/developer/dev-update-overlay.ts). Never set in production; when unset,
 * update envelopes enqueue immediately. A rejected preparer aborts the update
 * and is surfaced as a failed update result.
 */
export type ServerUpdatePreparer = () => Promise<void>;

let serverUpdatePreparer: ServerUpdatePreparer | null = null;

export function setServerUpdatePreparer(
  preparer: ServerUpdatePreparer | null,
): void {
  serverUpdatePreparer = preparer;
}

export function getServerUpdatePreparer(): ServerUpdatePreparer | null {
  return serverUpdatePreparer;
}
