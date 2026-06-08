import { Hono } from 'hono';
import { createSessionMiddleware } from './auth/middleware.ts';
import { broadcastToDaemons, dispatchCommand, listCommandResults, listDaemonConnections, listDaemonEvents, recordDaemonBroadcast, requestDaemonAddresses, sendToDaemon } from './daemon-hub.ts';
import { collectServerAddresses } from './server-addresses.ts';
import { ADMIN_API_PREFIX } from './surfaces.ts';
/**
 * Admin UI surface: fleet management, diagnostics, shell, addresses.
 * Mounted under {@link ADMIN_API_PREFIX} (`/api/admin/v1`).
 */ export function registerAdminRoutes(app, opts) {
  const admin = new Hono();
  admin.use('*', createSessionMiddleware(opts.sessionSecret));
  admin.get('/daemon/connections', (c)=>c.json({
      connections: listDaemonConnections()
    }));
  admin.get('/daemon/events', (c)=>{
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json({
      events: listDaemonEvents(Number.isFinite(limit) ? limit : 50)
    });
  });
  admin.post('/daemon/broadcast', async (c)=>{
    const body = await c.req.json().catch(()=>null);
    if (!body || typeof body !== 'object' || !('payload' in body)) {
      return c.json({
        error: 'expected { payload: unknown }'
      }, 400);
    }
    const message = {
      type: 'echo',
      payload: body.payload,
      at: new Date().toISOString()
    };
    const sent = broadcastToDaemons(message);
    recordDaemonBroadcast(sent, body.payload);
    return c.json({
      ok: true,
      sent
    });
  });
  admin.post('/daemon/:id/send', async (c)=>{
    const id = c.req.param('id');
    const body = await c.req.json().catch(()=>null);
    if (!body || typeof body !== 'object' || !('payload' in body)) {
      return c.json({
        error: 'expected { payload: unknown }'
      }, 400);
    }
    const message = {
      type: 'echo',
      payload: body.payload,
      at: new Date().toISOString()
    };
    const sent = sendToDaemon(id, message);
    if (!sent) return c.json({
      error: 'daemon not connected'
    }, 404);
    return c.json({
      ok: true,
      id
    });
  });
  admin.get('/daemon/commands', (c)=>{
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json({
      commands: listCommandResults(Number.isFinite(limit) ? limit : 50)
    });
  });
  admin.post('/daemon/command', async (c)=>{
    const body = await c.req.json().catch(()=>null);
    const command = typeof body?.command === 'string' ? body.command.trim() : '';
    if (!command) return c.json({
      error: 'expected { command: string }'
    }, 400);
    const commandIds = listDaemonConnections().map((conn)=>dispatchCommand(conn.id, command)).filter((id)=>id !== null);
    return c.json({
      ok: true,
      sent: commandIds.length,
      commandIds
    });
  });
  admin.post('/daemon/:id/command', async (c)=>{
    const id = c.req.param('id');
    const body = await c.req.json().catch(()=>null);
    const command = typeof body?.command === 'string' ? body.command.trim() : '';
    if (!command) return c.json({
      error: 'expected { command: string }'
    }, 400);
    const commandId = dispatchCommand(id, command);
    if (!commandId) return c.json({
      error: 'daemon not connected'
    }, 404);
    return c.json({
      ok: true,
      commandId
    });
  });
  admin.get('/instance/addresses', (c)=>{
    const addresses = collectServerAddresses();
    return c.json({
      ok: true,
      source: 'instance',
      addresses
    });
  });
  admin.get('/daemon/addresses', async (c)=>{
    const connections = listDaemonConnections();
    const servers = await Promise.all(connections.map(async (conn)=>{
      try {
        const addresses = await requestDaemonAddresses(conn.id);
        return {
          daemonId: conn.id,
          hostname: conn.hostname ?? null,
          addresses
        };
      } catch (err) {
        return {
          daemonId: conn.id,
          hostname: conn.hostname ?? null,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }));
    return c.json({
      servers
    });
  });
  admin.get('/daemon/:id/addresses', async (c)=>{
    const id = c.req.param('id');
    try {
      const addresses = await requestDaemonAddresses(id);
      const conn = listDaemonConnections().find((entry)=>entry.id === id);
      return c.json({
        ok: true,
        daemonId: id,
        hostname: conn?.hostname ?? null,
        addresses
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'daemon not connected' ? 404 : 500;
      return c.json({
        error: message
      }, status);
    }
  });
  app.route(ADMIN_API_PREFIX, admin);
  return app;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vb3B0L3R1cmJvcGFuZWwvcGxhdGZvcm0vdHVyYm9wYW5lbC9zcmMvYWRtaW4tcm91dGVzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IEhvbm8gfSBmcm9tICdob25vJ1xuaW1wb3J0IHsgY3JlYXRlU2Vzc2lvbk1pZGRsZXdhcmUgfSBmcm9tICcuL2F1dGgvbWlkZGxld2FyZS50cydcbmltcG9ydCB7XG4gIGJyb2FkY2FzdFRvRGFlbW9ucyxcbiAgdHlwZSBEYWVtb25NZXNzYWdlLFxuICBkaXNwYXRjaENvbW1hbmQsXG4gIGxpc3RDb21tYW5kUmVzdWx0cyxcbiAgbGlzdERhZW1vbkNvbm5lY3Rpb25zLFxuICBsaXN0RGFlbW9uRXZlbnRzLFxuICByZWNvcmREYWVtb25Ccm9hZGNhc3QsXG4gIHJlcXVlc3REYWVtb25BZGRyZXNzZXMsXG4gIHNlbmRUb0RhZW1vbixcbn0gZnJvbSAnLi9kYWVtb24taHViLnRzJ1xuaW1wb3J0IHsgY29sbGVjdFNlcnZlckFkZHJlc3NlcyB9IGZyb20gJy4vc2VydmVyLWFkZHJlc3Nlcy50cydcbmltcG9ydCB7IEFETUlOX0FQSV9QUkVGSVggfSBmcm9tICcuL3N1cmZhY2VzLnRzJ1xuXG4vKipcbiAqIEFkbWluIFVJIHN1cmZhY2U6IGZsZWV0IG1hbmFnZW1lbnQsIGRpYWdub3N0aWNzLCBzaGVsbCwgYWRkcmVzc2VzLlxuICogTW91bnRlZCB1bmRlciB7QGxpbmsgQURNSU5fQVBJX1BSRUZJWH0gKGAvYXBpL2FkbWluL3YxYCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlckFkbWluUm91dGVzKGFwcDogSG9ubywgb3B0czogeyBzZXNzaW9uU2VjcmV0OiBzdHJpbmcgfSkge1xuICBjb25zdCBhZG1pbiA9IG5ldyBIb25vKClcbiAgYWRtaW4udXNlKCcqJywgY3JlYXRlU2Vzc2lvbk1pZGRsZXdhcmUob3B0cy5zZXNzaW9uU2VjcmV0KSlcblxuICBhZG1pbi5nZXQoJy9kYWVtb24vY29ubmVjdGlvbnMnLCAoYykgPT5cbiAgICBjLmpzb24oeyBjb25uZWN0aW9uczogbGlzdERhZW1vbkNvbm5lY3Rpb25zKCkgfSkpXG5cbiAgYWRtaW4uZ2V0KCcvZGFlbW9uL2V2ZW50cycsIChjKSA9PiB7XG4gICAgY29uc3QgbGltaXQgPSBOdW1iZXIoYy5yZXEucXVlcnkoJ2xpbWl0JykgPz8gNTApXG4gICAgcmV0dXJuIGMuanNvbih7IGV2ZW50czogbGlzdERhZW1vbkV2ZW50cyhOdW1iZXIuaXNGaW5pdGUobGltaXQpID8gbGltaXQgOiA1MCkgfSlcbiAgfSlcblxuICBhZG1pbi5wb3N0KCcvZGFlbW9uL2Jyb2FkY2FzdCcsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgYm9keSA9IGF3YWl0IGMucmVxLmpzb24oKS5jYXRjaCgoKSA9PiBudWxsKVxuICAgIGlmICghYm9keSB8fCB0eXBlb2YgYm9keSAhPT0gJ29iamVjdCcgfHwgISgncGF5bG9hZCcgaW4gYm9keSkpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2V4cGVjdGVkIHsgcGF5bG9hZDogdW5rbm93biB9JyB9LCA0MDApXG4gICAgfVxuXG4gICAgY29uc3QgbWVzc2FnZTogRGFlbW9uTWVzc2FnZSA9IHtcbiAgICAgIHR5cGU6ICdlY2hvJyxcbiAgICAgIHBheWxvYWQ6IGJvZHkucGF5bG9hZCxcbiAgICAgIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgfVxuICAgIGNvbnN0IHNlbnQgPSBicm9hZGNhc3RUb0RhZW1vbnMobWVzc2FnZSlcbiAgICByZWNvcmREYWVtb25Ccm9hZGNhc3Qoc2VudCwgYm9keS5wYXlsb2FkKVxuICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSwgc2VudCB9KVxuICB9KVxuXG4gIGFkbWluLnBvc3QoJy9kYWVtb24vOmlkL3NlbmQnLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IGlkID0gYy5yZXEucGFyYW0oJ2lkJylcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgYy5yZXEuanNvbigpLmNhdGNoKCgpID0+IG51bGwpXG4gICAgaWYgKCFib2R5IHx8IHR5cGVvZiBib2R5ICE9PSAnb2JqZWN0JyB8fCAhKCdwYXlsb2FkJyBpbiBib2R5KSkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZXhwZWN0ZWQgeyBwYXlsb2FkOiB1bmtub3duIH0nIH0sIDQwMClcbiAgICB9XG5cbiAgICBjb25zdCBtZXNzYWdlOiBEYWVtb25NZXNzYWdlID0ge1xuICAgICAgdHlwZTogJ2VjaG8nLFxuICAgICAgcGF5bG9hZDogYm9keS5wYXlsb2FkLFxuICAgICAgYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICB9XG4gICAgY29uc3Qgc2VudCA9IHNlbmRUb0RhZW1vbihpZCwgbWVzc2FnZSlcbiAgICBpZiAoIXNlbnQpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2RhZW1vbiBub3QgY29ubmVjdGVkJyB9LCA0MDQpXG4gICAgcmV0dXJuIGMuanNvbih7IG9rOiB0cnVlLCBpZCB9KVxuICB9KVxuXG4gIGFkbWluLmdldCgnL2RhZW1vbi9jb21tYW5kcycsIChjKSA9PiB7XG4gICAgY29uc3QgbGltaXQgPSBOdW1iZXIoYy5yZXEucXVlcnkoJ2xpbWl0JykgPz8gNTApXG4gICAgcmV0dXJuIGMuanNvbih7IGNvbW1hbmRzOiBsaXN0Q29tbWFuZFJlc3VsdHMoTnVtYmVyLmlzRmluaXRlKGxpbWl0KSA/IGxpbWl0IDogNTApIH0pXG4gIH0pXG5cbiAgYWRtaW4ucG9zdCgnL2RhZW1vbi9jb21tYW5kJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgYy5yZXEuanNvbigpLmNhdGNoKCgpID0+IG51bGwpXG4gICAgY29uc3QgY29tbWFuZCA9IHR5cGVvZiBib2R5Py5jb21tYW5kID09PSAnc3RyaW5nJyA/IGJvZHkuY29tbWFuZC50cmltKCkgOiAnJ1xuICAgIGlmICghY29tbWFuZCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZXhwZWN0ZWQgeyBjb21tYW5kOiBzdHJpbmcgfScgfSwgNDAwKVxuXG4gICAgY29uc3QgY29tbWFuZElkcyA9IGxpc3REYWVtb25Db25uZWN0aW9ucygpXG4gICAgICAubWFwKChjb25uKSA9PiBkaXNwYXRjaENvbW1hbmQoY29ubi5pZCwgY29tbWFuZCkpXG4gICAgICAuZmlsdGVyKChpZCk6IGlkIGlzIHN0cmluZyA9PiBpZCAhPT0gbnVsbClcbiAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIHNlbnQ6IGNvbW1hbmRJZHMubGVuZ3RoLCBjb21tYW5kSWRzIH0pXG4gIH0pXG5cbiAgYWRtaW4ucG9zdCgnL2RhZW1vbi86aWQvY29tbWFuZCcsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgaWQgPSBjLnJlcS5wYXJhbSgnaWQnKVxuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCBjLnJlcS5qc29uKCkuY2F0Y2goKCkgPT4gbnVsbClcbiAgICBjb25zdCBjb21tYW5kID0gdHlwZW9mIGJvZHk/LmNvbW1hbmQgPT09ICdzdHJpbmcnID8gYm9keS5jb21tYW5kLnRyaW0oKSA6ICcnXG4gICAgaWYgKCFjb21tYW5kKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdleHBlY3RlZCB7IGNvbW1hbmQ6IHN0cmluZyB9JyB9LCA0MDApXG5cbiAgICBjb25zdCBjb21tYW5kSWQgPSBkaXNwYXRjaENvbW1hbmQoaWQsIGNvbW1hbmQpXG4gICAgaWYgKCFjb21tYW5kSWQpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2RhZW1vbiBub3QgY29ubmVjdGVkJyB9LCA0MDQpXG4gICAgcmV0dXJuIGMuanNvbih7IG9rOiB0cnVlLCBjb21tYW5kSWQgfSlcbiAgfSlcblxuICBhZG1pbi5nZXQoJy9pbnN0YW5jZS9hZGRyZXNzZXMnLCAoYykgPT4ge1xuICAgIGNvbnN0IGFkZHJlc3NlcyA9IGNvbGxlY3RTZXJ2ZXJBZGRyZXNzZXMoKVxuICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSwgc291cmNlOiAnaW5zdGFuY2UnLCBhZGRyZXNzZXMgfSlcbiAgfSlcblxuICBhZG1pbi5nZXQoJy9kYWVtb24vYWRkcmVzc2VzJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBjb25uZWN0aW9ucyA9IGxpc3REYWVtb25Db25uZWN0aW9ucygpXG4gICAgY29uc3Qgc2VydmVycyA9IGF3YWl0IFByb21pc2UuYWxsKFxuICAgICAgY29ubmVjdGlvbnMubWFwKGFzeW5jIChjb25uKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgYWRkcmVzc2VzID0gYXdhaXQgcmVxdWVzdERhZW1vbkFkZHJlc3Nlcyhjb25uLmlkKVxuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBkYWVtb25JZDogY29ubi5pZCxcbiAgICAgICAgICAgIGhvc3RuYW1lOiBjb25uLmhvc3RuYW1lID8/IG51bGwsXG4gICAgICAgICAgICBhZGRyZXNzZXMsXG4gICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgZGFlbW9uSWQ6IGNvbm4uaWQsXG4gICAgICAgICAgICBob3N0bmFtZTogY29ubi5ob3N0bmFtZSA/PyBudWxsLFxuICAgICAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0pLFxuICAgIClcbiAgICByZXR1cm4gYy5qc29uKHsgc2VydmVycyB9KVxuICB9KVxuXG4gIGFkbWluLmdldCgnL2RhZW1vbi86aWQvYWRkcmVzc2VzJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBpZCA9IGMucmVxLnBhcmFtKCdpZCcpXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGFkZHJlc3NlcyA9IGF3YWl0IHJlcXVlc3REYWVtb25BZGRyZXNzZXMoaWQpXG4gICAgICBjb25zdCBjb25uID0gbGlzdERhZW1vbkNvbm5lY3Rpb25zKCkuZmluZCgoZW50cnkpID0+IGVudHJ5LmlkID09PSBpZClcbiAgICAgIHJldHVybiBjLmpzb24oe1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgZGFlbW9uSWQ6IGlkLFxuICAgICAgICBob3N0bmFtZTogY29ubj8uaG9zdG5hbWUgPz8gbnVsbCxcbiAgICAgICAgYWRkcmVzc2VzLFxuICAgICAgfSlcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycilcbiAgICAgIGNvbnN0IHN0YXR1cyA9IG1lc3NhZ2UgPT09ICdkYWVtb24gbm90IGNvbm5lY3RlZCcgPyA0MDQgOiA1MDBcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogbWVzc2FnZSB9LCBzdGF0dXMpXG4gICAgfVxuICB9KVxuXG4gIGFwcC5yb3V0ZShBRE1JTl9BUElfUFJFRklYLCBhZG1pbilcbiAgcmV0dXJuIGFwcFxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLFNBQVMsSUFBSSxRQUFRLE9BQU07QUFDM0IsU0FBUyx1QkFBdUIsUUFBUSx1QkFBc0I7QUFDOUQsU0FDRSxrQkFBa0IsRUFFbEIsZUFBZSxFQUNmLGtCQUFrQixFQUNsQixxQkFBcUIsRUFDckIsZ0JBQWdCLEVBQ2hCLHFCQUFxQixFQUNyQixzQkFBc0IsRUFDdEIsWUFBWSxRQUNQLGtCQUFpQjtBQUN4QixTQUFTLHNCQUFzQixRQUFRLHdCQUF1QjtBQUM5RCxTQUFTLGdCQUFnQixRQUFRLGdCQUFlO0FBRWhEOzs7Q0FHQyxHQUNELE9BQU8sU0FBUyxvQkFBb0IsR0FBUyxFQUFFLElBQStCO0VBQzVFLE1BQU0sUUFBUSxJQUFJO0VBQ2xCLE1BQU0sR0FBRyxDQUFDLEtBQUssd0JBQXdCLEtBQUssYUFBYTtFQUV6RCxNQUFNLEdBQUcsQ0FBQyx1QkFBdUIsQ0FBQyxJQUNoQyxFQUFFLElBQUksQ0FBQztNQUFFLGFBQWE7SUFBd0I7RUFFaEQsTUFBTSxHQUFHLENB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
// denoCacheMetadata=3641993757200387897,6257625695018300968