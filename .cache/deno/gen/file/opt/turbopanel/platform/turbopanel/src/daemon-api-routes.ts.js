import { Hono } from 'hono';
import { resolveInstanceTlsCaPath } from './server-paths.ts';
import { DAEMON_API_PREFIX } from './surfaces.ts';
/**
 * Daemon-facing surface: endpoints agent nodes and the node installer call.
 * Mounted under {@link DAEMON_API_PREFIX} (`/api/daemon/v1`).
 */ export function registerDaemonApiRoutes(app) {
  const daemon = new Hono();
  // Platform CA PEM — agents add this to their trust store before dialing in.
  daemon.get('/instance/ca', async (c)=>{
    try {
      const cert = await Deno.readTextFile(resolveInstanceTlsCaPath());
      return c.body(cert, 200, {
        'content-type': 'application/x-pem-file'
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({
        error: message
      }, 500);
    }
  });
  app.route(DAEMON_API_PREFIX, daemon);
  return app;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vb3B0L3R1cmJvcGFuZWwvcGxhdGZvcm0vdHVyYm9wYW5lbC9zcmMvZGFlbW9uLWFwaS1yb3V0ZXMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgSG9ubyB9IGZyb20gJ2hvbm8nXG5pbXBvcnQgeyByZXNvbHZlSW5zdGFuY2VUbHNDYVBhdGggfSBmcm9tICcuL3NlcnZlci1wYXRocy50cydcbmltcG9ydCB7IERBRU1PTl9BUElfUFJFRklYIH0gZnJvbSAnLi9zdXJmYWNlcy50cydcblxuLyoqXG4gKiBEYWVtb24tZmFjaW5nIHN1cmZhY2U6IGVuZHBvaW50cyBhZ2VudCBub2RlcyBhbmQgdGhlIG5vZGUgaW5zdGFsbGVyIGNhbGwuXG4gKiBNb3VudGVkIHVuZGVyIHtAbGluayBEQUVNT05fQVBJX1BSRUZJWH0gKGAvYXBpL2RhZW1vbi92MWApLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJEYWVtb25BcGlSb3V0ZXMoYXBwOiBIb25vKSB7XG4gIGNvbnN0IGRhZW1vbiA9IG5ldyBIb25vKClcblxuICAvLyBQbGF0Zm9ybSBDQSBQRU0g4oCUIGFnZW50cyBhZGQgdGhpcyB0byB0aGVpciB0cnVzdCBzdG9yZSBiZWZvcmUgZGlhbGluZyBpbi5cbiAgZGFlbW9uLmdldCgnL2luc3RhbmNlL2NhJywgYXN5bmMgKGMpID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgY2VydCA9IGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKHJlc29sdmVJbnN0YW5jZVRsc0NhUGF0aCgpKVxuICAgICAgcmV0dXJuIGMuYm9keShjZXJ0LCAyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi94LXBlbS1maWxlJyB9KVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiBtZXNzYWdlIH0sIDUwMClcbiAgICB9XG4gIH0pXG5cbiAgYXBwLnJvdXRlKERBRU1PTl9BUElfUFJFRklYLCBkYWVtb24pXG4gIHJldHVybiBhcHBcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUFTLElBQUksUUFBUSxPQUFNO0FBQzNCLFNBQVMsd0JBQXdCLFFBQVEsb0JBQW1CO0FBQzVELFNBQVMsaUJBQWlCLFFBQVEsZ0JBQWU7QUFFakQ7OztDQUdDLEdBQ0QsT0FBTyxTQUFTLHdCQUF3QixHQUFTO0VBQy9DLE1BQU0sU0FBUyxJQUFJO0VBRW5CLDRFQUE0RTtFQUM1RSxPQUFPLEdBQUcsQ0FBQyxnQkFBZ0IsT0FBTztJQUNoQyxJQUFJO01BQ0YsTUFBTSxPQUFPLE1BQU0sS0FBSyxZQUFZLENBQUM7TUFDckMsT0FBTyxFQUFFLElBQUksQ0FBQyxNQUFNLEtBQUs7UUFBRSxnQkFBZ0I7TUFBeUI7SUFDdEUsRUFBRSxPQUFPLEtBQUs7TUFDWixNQUFNLFVBQVUsZUFBZSxRQUFRLElBQUksT0FBTyxHQUFHLE9BQU87TUFDNUQsT0FBTyxFQUFFLElBQUksQ0FBQztRQUFFLE9BQU87TUFBUSxHQUFHO0lBQ3BDO0VBQ0Y7RUFFQSxJQUFJLEtBQUssQ0FBQyxtQkFBbUI7RUFDN0IsT0FBTztBQUNUIn0=
// denoCacheMetadata=14240738091499830285,9023851789910175997