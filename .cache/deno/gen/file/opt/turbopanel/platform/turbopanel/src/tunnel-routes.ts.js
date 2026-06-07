import { awaitDaemonAck, getColocatedDaemonId, sendToDaemon } from './daemon-hub.ts';
import { DEVELOPER_API_PREFIX } from './surfaces.ts';
const TUNNEL_TOKEN_TIMEOUT_MS = 30_000;
/**
 * Set the self-hosted instance's Cloudflare tunnel token. The token is pushed
 * to the co-located daemon (which runs cloudflared), exposing this instance so
 * external agent nodes can connect in. An empty token tears the tunnel down.
 */ export function registerTunnelRoutes(app) {
  app.post(`${DEVELOPER_API_PREFIX}/instance/tunnel-token`, async (c)=>{
    const body = await c.req.json().catch(()=>null);
    if (!body || typeof body !== 'object' || typeof body.token !== 'string') {
      return c.json({
        ok: false,
        error: 'expected { token: string }'
      }, 400);
    }
    const daemonId = getColocatedDaemonId();
    if (!daemonId) {
      return c.json({
        ok: false,
        error: 'no co-located daemon connected to run the tunnel'
      }, 503);
    }
    const id = crypto.randomUUID();
    const message = {
      type: 'tunnel-token',
      id,
      token: body.token,
      at: new Date().toISOString()
    };
    const ack = awaitDaemonAck(id, TUNNEL_TOKEN_TIMEOUT_MS);
    if (!sendToDaemon(daemonId, message)) {
      return c.json({
        ok: false,
        error: 'co-located daemon disconnected'
      }, 503);
    }
    try {
      await ack;
      return c.json({
        ok: true
      });
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return c.json({
        ok: false,
        error: errMessage
      }, 500);
    }
  });
  return app;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vb3B0L3R1cmJvcGFuZWwvcGxhdGZvcm0vdHVyYm9wYW5lbC9zcmMvdHVubmVsLXJvdXRlcy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IEhvbm8gfSBmcm9tICdob25vJ1xuaW1wb3J0IHtcbiAgYXdhaXREYWVtb25BY2ssXG4gIHR5cGUgRGFlbW9uTWVzc2FnZSxcbiAgZ2V0Q29sb2NhdGVkRGFlbW9uSWQsXG4gIHNlbmRUb0RhZW1vbixcbn0gZnJvbSAnLi9kYWVtb24taHViLnRzJ1xuaW1wb3J0IHsgREVWRUxPUEVSX0FQSV9QUkVGSVggfSBmcm9tICcuL3N1cmZhY2VzLnRzJ1xuXG5jb25zdCBUVU5ORUxfVE9LRU5fVElNRU9VVF9NUyA9IDMwXzAwMFxuXG4vKipcbiAqIFNldCB0aGUgc2VsZi1ob3N0ZWQgaW5zdGFuY2UncyBDbG91ZGZsYXJlIHR1bm5lbCB0b2tlbi4gVGhlIHRva2VuIGlzIHB1c2hlZFxuICogdG8gdGhlIGNvLWxvY2F0ZWQgZGFlbW9uICh3aGljaCBydW5zIGNsb3VkZmxhcmVkKSwgZXhwb3NpbmcgdGhpcyBpbnN0YW5jZSBzb1xuICogZXh0ZXJuYWwgYWdlbnQgbm9kZXMgY2FuIGNvbm5lY3QgaW4uIEFuIGVtcHR5IHRva2VuIHRlYXJzIHRoZSB0dW5uZWwgZG93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyVHVubmVsUm91dGVzKGFwcDogSG9ubyk6IEhvbm8ge1xuICBhcHAucG9zdChgJHtERVZFTE9QRVJfQVBJX1BSRUZJWH0vaW5zdGFuY2UvdHVubmVsLXRva2VuYCwgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgYy5yZXEuanNvbigpLmNhdGNoKCgpID0+IG51bGwpXG4gICAgaWYgKCFib2R5IHx8IHR5cGVvZiBib2R5ICE9PSAnb2JqZWN0JyB8fCB0eXBlb2YgYm9keS50b2tlbiAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiAnZXhwZWN0ZWQgeyB0b2tlbjogc3RyaW5nIH0nIH0sIDQwMClcbiAgICB9XG5cbiAgICBjb25zdCBkYWVtb25JZCA9IGdldENvbG9jYXRlZERhZW1vbklkKClcbiAgICBpZiAoIWRhZW1vbklkKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7IG9rOiBmYWxzZSwgZXJyb3I6ICdubyBjby1sb2NhdGVkIGRhZW1vbiBjb25uZWN0ZWQgdG8gcnVuIHRoZSB0dW5uZWwnIH0sXG4gICAgICAgIDUwMyxcbiAgICAgIClcbiAgICB9XG5cbiAgICBjb25zdCBpZCA9IGNyeXB0by5yYW5kb21VVUlEKClcbiAgICBjb25zdCBtZXNzYWdlOiBEYWVtb25NZXNzYWdlID0ge1xuICAgICAgdHlwZTogJ3R1bm5lbC10b2tlbicsXG4gICAgICBpZCxcbiAgICAgIHRva2VuOiBib2R5LnRva2VuLFxuICAgICAgYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICB9XG4gICAgY29uc3QgYWNrID0gYXdhaXREYWVtb25BY2soaWQsIFRVTk5FTF9UT0tFTl9USU1FT1VUX01TKVxuICAgIGlmICghc2VuZFRvRGFlbW9uKGRhZW1vbklkLCBtZXNzYWdlKSkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6ICdjby1sb2NhdGVkIGRhZW1vbiBkaXNjb25uZWN0ZWQnIH0sIDUwMylcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgYWNrXG4gICAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUgfSlcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IGVyck1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycilcbiAgICAgIHJldHVybiBjLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBlcnJNZXNzYWdlIH0sIDUwMClcbiAgICB9XG4gIH0pXG5cbiAgcmV0dXJuIGFwcFxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLFNBQ0UsY0FBYyxFQUVkLG9CQUFvQixFQUNwQixZQUFZLFFBQ1Asa0JBQWlCO0FBQ3hCLFNBQVMsb0JBQW9CLFFBQVEsZ0JBQWU7QUFFcEQsTUFBTSwwQkFBMEI7QUFFaEM7Ozs7Q0FJQyxHQUNELE9BQU8sU0FBUyxxQkFBcUIsR0FBUztFQUM1QyxJQUFJLElBQUksQ0FBQyxHQUFHLHFCQUFxQixzQkFBc0IsQ0FBQyxFQUFFLE9BQU87SUFDL0QsTUFBTSxPQUFPLE1BQU0sRUFBRSxHQUFHLENBQUMsSUFBSSxHQUFHLEtBQUssQ0FBQyxJQUFNO0lBQzVDLElBQUksQ0FBQyxRQUFRLE9BQU8sU0FBUyxZQUFZLE9BQU8sS0FBSyxLQUFLLEtBQUssVUFBVTtNQUN2RSxPQUFPLEVBQUUsSUFBSSxDQUFDO1FBQUUsSUFBSTtRQUFPLE9BQU87TUFBNkIsR0FBRztJQUNwRTtJQUVBLE1BQU0sV0FBVztJQUNqQixJQUFJLENBQUMsVUFBVTtNQUNiLE9BQU8sRUFBRSxJQUFJLENBQ1g7UUFBRSxJQUFJO1FBQU8sT0FBTztNQUFtRCxHQUN2RTtJQUVKO0lBRUEsTUFBTSxLQUFLLE9BQU8sVUFBVTtJQUM1QixNQUFNLFVBQXlCO01BQzdCLE1BQU07TUFDTjtNQUNBLE9BQU8sS0FBSyxLQUFLO01BQ2pCLElBQUksSUFBSSxPQUFPLFdBQVc7SUFDNUI7SUFDQSxNQUFNLE1BQU0sZUFBZSxJQUFJO0lBQy9CLElBQUksQ0FBQyxhQUFhLFVBQVUsVUFBVTtNQUNwQyxPQUFPLEVBQUUsSUFBSSxDQUFDO1FBQUUsSUFBSTtRQUFPLE9BQU87TUFBaUMsR0FBRztJQUN4RTtJQUVBLElBQUk7TUFDRixNQUFNO01BQ04sT0FBTyxFQUFFLElBQUksQ0FBQztRQUFFLElBQUk7TUFBSztJQUMzQixFQUFFLE9BQU8sS0FBSztNQUNaLE1BQU0sYUFBYSxlQUFlLFFBQVEsSUFBSSxPQUFPLEdBQUcsT0FBTztNQUMvRCxPQUFPLEVBQUUsSUFBSSxDQUFDO1FBQUUsSUFBSTtRQUFPLE9BQU87TUFBVyxHQUFHO0lBQ2xEO0VBQ0Y7RUFFQSxPQUFPO0FBQ1QifQ==
// denoCacheMetadata=9629801729640210650,10894886841724594908