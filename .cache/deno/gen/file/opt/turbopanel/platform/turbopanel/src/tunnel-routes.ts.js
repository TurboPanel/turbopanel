import { createRootOnlyMiddleware } from './auth/middleware.ts';
import { awaitDaemonAck, getColocatedDaemonId, sendToDaemon } from './daemon-hub.ts';
import { DEVELOPER_API_PREFIX } from './surfaces.ts';
const TUNNEL_TOKEN_TIMEOUT_MS = 30_000;
/**
 * Set the self-hosted instance's Cloudflare tunnel token. The token is pushed
 * to the co-located daemon (which runs cloudflared), exposing this instance so
 * external agent nodes can connect in. An empty token tears the tunnel down.
 */ export function registerTunnelRoutes(app, opts) {
  app.use(`${DEVELOPER_API_PREFIX}/instance/tunnel-token`, createRootOnlyMiddleware(opts.sessionSecret));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vb3B0L3R1cmJvcGFuZWwvcGxhdGZvcm0vdHVyYm9wYW5lbC9zcmMvdHVubmVsLXJvdXRlcy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IEhvbm8gfSBmcm9tICdob25vJ1xuaW1wb3J0IHsgY3JlYXRlUm9vdE9ubHlNaWRkbGV3YXJlIH0gZnJvbSAnLi9hdXRoL21pZGRsZXdhcmUudHMnXG5pbXBvcnQge1xuICBhd2FpdERhZW1vbkFjayxcbiAgdHlwZSBEYWVtb25NZXNzYWdlLFxuICBnZXRDb2xvY2F0ZWREYWVtb25JZCxcbiAgc2VuZFRvRGFlbW9uLFxufSBmcm9tICcuL2RhZW1vbi1odWIudHMnXG5pbXBvcnQgeyBERVZFTE9QRVJfQVBJX1BSRUZJWCB9IGZyb20gJy4vc3VyZmFjZXMudHMnXG5cbmNvbnN0IFRVTk5FTF9UT0tFTl9USU1FT1VUX01TID0gMzBfMDAwXG5cbi8qKlxuICogU2V0IHRoZSBzZWxmLWhvc3RlZCBpbnN0YW5jZSdzIENsb3VkZmxhcmUgdHVubmVsIHRva2VuLiBUaGUgdG9rZW4gaXMgcHVzaGVkXG4gKiB0byB0aGUgY28tbG9jYXRlZCBkYWVtb24gKHdoaWNoIHJ1bnMgY2xvdWRmbGFyZWQpLCBleHBvc2luZyB0aGlzIGluc3RhbmNlIHNvXG4gKiBleHRlcm5hbCBhZ2VudCBub2RlcyBjYW4gY29ubmVjdCBpbi4gQW4gZW1wdHkgdG9rZW4gdGVhcnMgdGhlIHR1bm5lbCBkb3duLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJUdW5uZWxSb3V0ZXMoXG4gIGFwcDogSG9ubyxcbiAgb3B0czogeyBzZXNzaW9uU2VjcmV0OiBzdHJpbmcgfSxcbik6IEhvbm8ge1xuICBhcHAudXNlKGAke0RFVkVMT1BFUl9BUElfUFJFRklYfS9pbnN0YW5jZS90dW5uZWwtdG9rZW5gLCBjcmVhdGVSb290T25seU1pZGRsZXdhcmUob3B0cy5zZXNzaW9uU2VjcmV0KSlcblxuICBhcHAucG9zdChgJHtERVZFTE9QRVJfQVBJX1BSRUZJWH0vaW5zdGFuY2UvdHVubmVsLXRva2VuYCwgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgYy5yZXEuanNvbigpLmNhdGNoKCgpID0+IG51bGwpXG4gICAgaWYgKCFib2R5IHx8IHR5cGVvZiBib2R5ICE9PSAnb2JqZWN0JyB8fCB0eXBlb2YgYm9keS50b2tlbiAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiAnZXhwZWN0ZWQgeyB0b2tlbjogc3RyaW5nIH0nIH0sIDQwMClcbiAgICB9XG5cbiAgICBjb25zdCBkYWVtb25JZCA9IGdldENvbG9jYXRlZERhZW1vbklkKClcbiAgICBpZiAoIWRhZW1vbklkKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7IG9rOiBmYWxzZSwgZXJyb3I6ICdubyBjby1sb2NhdGVkIGRhZW1vbiBjb25uZWN0ZWQgdG8gcnVuIHRoZSB0dW5uZWwnIH0sXG4gICAgICAgIDUwMyxcbiAgICAgIClcbiAgICB9XG5cbiAgICBjb25zdCBpZCA9IGNyeXB0by5yYW5kb21VVUlEKClcbiAgICBjb25zdCBtZXNzYWdlOiBEYWVtb25NZXNzYWdlID0ge1xuICAgICAgdHlwZTogJ3R1bm5lbC10b2tlbicsXG4gICAgICBpZCxcbiAgICAgIHRva2VuOiBib2R5LnRva2VuLFxuICAgICAgYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICB9XG4gICAgY29uc3QgYWNrID0gYXdhaXREYWVtb25BY2soaWQsIFRVTk5FTF9UT0tFTl9USU1FT1VUX01TKVxuICAgIGlmICghc2VuZFRvRGFlbW9uKGRhZW1vbklkLCBtZXNzYWdlKSkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6ICdjby1sb2NhdGVkIGRhZW1vbiBkaXNjb25uZWN0ZWQnIH0sIDUwMylcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgYWNrXG4gICAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUgfSlcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IGVyck1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycilcbiAgICAgIHJldHVybiBjLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBlcnJNZXNzYWdlIH0sIDUwMClcbiAgICB9XG4gIH0pXG5cbiAgcmV0dXJuIGFwcFxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLFNBQVMsd0JBQXdCLFFBQVEsdUJBQXNCO0FBQy9ELFNBQ0UsY0FBYyxFQUVkLG9CQUFvQixFQUNwQixZQUFZLFFBQ1Asa0JBQWlCO0FBQ3hCLFNBQVMsb0JBQW9CLFFBQVEsZ0JBQWU7QUFFcEQsTUFBTSwwQkFBMEI7QUFFaEM7Ozs7Q0FJQyxHQUNELE9BQU8sU0FBUyxxQkFDZCxHQUFTLEVBQ1QsSUFBK0I7RUFFL0IsSUFBSSxHQUFHLENBQUMsR0FBRyxxQkFBcUIsc0JBQXNCLENBQUMsRUFBRSx5QkFBeUIsS0FBSyxhQUFhO0VBRXBHLElBQUksSUFBSSxDQUFDLEdBQUcscUJBQXFCLHNCQUFzQixDQUFDLEVBQUUsT0FBTztJQUMvRCxNQUFNLE9BQU8sTUFBTSxFQUFFLEdBQUcsQ0FBQyxJQUFJLEdBQUcsS0FBSyxDQUFDLElBQU07SUFDNUMsSUFBSSxDQUFDLFFBQVEsT0FBTyxTQUFTLFlBQVksT0FBTyxLQUFLLEtBQUssS0FBSyxVQUFVO01BQ3ZFLE9BQU8sRUFBRSxJQUFJLENBQUM7UUFBRSxJQUFJO1FBQU8sT0FBTztNQUE2QixHQUFHO0lBQ3BFO0lBRUEsTUFBTSxXQUFXO0lBQ2pCLElBQUksQ0FBQyxVQUFVO01BQ2IsT0FBTyxFQUFFLElBQUksQ0FDWDtRQUFFLElBQUk7UUFBTyxPQUFPO01BQW1ELEdBQ3ZFO0lBRUo7SUFFQSxNQUFNLEtBQUssT0FBTyxVQUFVO0lBQzVCLE1BQU0sVUFBeUI7TUFDN0IsTUFBTTtNQUNOO01BQ0EsT0FBTyxLQUFLLEtBQUs7TUFDakIsSUFBSSxJQUFJLE9BQU8sV0FBVztJQUM1QjtJQUNBLE1BQU0sTUFBTSxlQUFlLElBQUk7SUFDL0IsSUFBSSxDQUFDLGFBQWEsVUFBVSxVQUFVO01BQ3BDLE9BQU8sRUFBRSxJQUFJLENBQUM7UUFBRSxJQUFJO1FBQU8sT0FBTztNQUFpQyxHQUFHO0lBQ3hFO0lBRUEsSUFBSTtNQUNGLE1BQU07TUFDTixPQUFPLEVBQUUsSUFBSSxDQUFDO1FBQUUsSUFBSTtNQUFLO0lBQzNCLEVBQUUsT0FBTyxLQUFLO01BQ1osTUFBTSxhQUFhLGVBQWUsUUFBUSxJQUFJLE9BQU8sR0FBRyxPQUFPO01BQy9ELE9BQU8sRUFBRSxJQUFJLENBQUM7UUFBRSxJQUFJO1FBQU8sT0FBTztNQUFXLEdBQUc7SUFDbEQ7RUFDRjtFQUVBLE9BQU87QUFDVCJ9
// denoCacheMetadata=11149304597467925748,12146930672391519194