import { Hono } from 'hono';
import { createRootOnlyMiddleware } from './auth/middleware.ts';
import { broadcastToDaemons, dispatchCommand, listCommandResults, listDaemonConnections, listDaemonEvents, recordDaemonBroadcast, requestDaemonAddresses, sendToDaemon } from './daemon-hub.ts';
import { collectServerAddresses } from './server-addresses.ts';
import { registerDatabaseRoutes } from './database-routes.ts';
import { EXPO_UI_SERVICE, expoTmuxStatus } from './expo-pty.ts';
import { DEVELOPER_API_PREFIX } from './surfaces.ts';
/**
 * Developer console surface: fleet management, diagnostics, shell, addresses.
 * Mounted under {@link DEVELOPER_API_PREFIX} (`/api/developer/v1`). Dev-only —
 * the caller (`deno.ts`) registers this surface only when dev mode is enabled.
 */ export function registerDeveloperRoutes(app, opts) {
  const developer = new Hono();
  developer.use('*', createRootOnlyMiddleware(opts.sessionSecret));
  developer.get('/daemon/connections', (c)=>c.json({
      connections: listDaemonConnections()
    }));
  developer.get('/daemon/events', (c)=>{
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json({
      events: listDaemonEvents(Number.isFinite(limit) ? limit : 50)
    });
  });
  developer.post('/daemon/broadcast', async (c)=>{
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
  developer.post('/daemon/:id/send', async (c)=>{
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
  developer.get('/daemon/commands', (c)=>{
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json({
      commands: listCommandResults(Number.isFinite(limit) ? limit : 50)
    });
  });
  developer.post('/daemon/command', async (c)=>{
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
  developer.post('/daemon/:id/command', async (c)=>{
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
  developer.get('/instance/addresses', (c)=>{
    const addresses = collectServerAddresses();
    return c.json({
      ok: true,
      source: 'instance',
      addresses
    });
  });
  developer.get('/daemon/addresses', async (c)=>{
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
  developer.get('/daemon/:id/addresses', async (c)=>{
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
  registerDatabaseRoutes(developer);
  developer.get('/expo/status', async (c)=>{
    const { running } = await expoTmuxStatus();
    return c.json({
      running
    });
  });
  developer.post('/expo/restart', (c)=>{
    if (!EXPO_UI_SERVICE) {
      return c.json({
        ok: false,
        error: 'expo restart unavailable: TURBOPANEL_UI_SERVICE is not set (run under systemd or configure a managed service)'
      }, 503);
    }
    new Deno.Command('sudo', {
      args: [
        'systemctl',
        'restart',
        EXPO_UI_SERVICE
      ],
      stdin: 'null',
      stdout: 'null',
      stderr: 'null'
    }).spawn();
    return c.json({
      ok: true
    });
  });
  app.route(DEVELOPER_API_PREFIX, developer);
  return app;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vb3B0L3R1cmJvcGFuZWwvcGxhdGZvcm0vdHVyYm9wYW5lbC9zcmMvZGV2ZWxvcGVyLXJvdXRlcy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBIb25vIH0gZnJvbSAnaG9ubydcbmltcG9ydCB7IGNyZWF0ZVJvb3RPbmx5TWlkZGxld2FyZSB9IGZyb20gJy4vYXV0aC9taWRkbGV3YXJlLnRzJ1xuaW1wb3J0IHtcbiAgYnJvYWRjYXN0VG9EYWVtb25zLFxuICB0eXBlIERhZW1vbk1lc3NhZ2UsXG4gIGRpc3BhdGNoQ29tbWFuZCxcbiAgbGlzdENvbW1hbmRSZXN1bHRzLFxuICBsaXN0RGFlbW9uQ29ubmVjdGlvbnMsXG4gIGxpc3REYWVtb25FdmVudHMsXG4gIHJlY29yZERhZW1vbkJyb2FkY2FzdCxcbiAgcmVxdWVzdERhZW1vbkFkZHJlc3NlcyxcbiAgc2VuZFRvRGFlbW9uLFxufSBmcm9tICcuL2RhZW1vbi1odWIudHMnXG5pbXBvcnQgeyBjb2xsZWN0U2VydmVyQWRkcmVzc2VzIH0gZnJvbSAnLi9zZXJ2ZXItYWRkcmVzc2VzLnRzJ1xuaW1wb3J0IHsgcmVnaXN0ZXJEYXRhYmFzZVJvdXRlcyB9IGZyb20gJy4vZGF0YWJhc2Utcm91dGVzLnRzJ1xuaW1wb3J0IHsgRVhQT19VSV9TRVJWSUNFLCBleHBvVG11eFN0YXR1cyB9IGZyb20gJy4vZXhwby1wdHkudHMnXG5pbXBvcnQgeyBERVZFTE9QRVJfQVBJX1BSRUZJWCB9IGZyb20gJy4vc3VyZmFjZXMudHMnXG5cbi8qKlxuICogRGV2ZWxvcGVyIGNvbnNvbGUgc3VyZmFjZTogZmxlZXQgbWFuYWdlbWVudCwgZGlhZ25vc3RpY3MsIHNoZWxsLCBhZGRyZXNzZXMuXG4gKiBNb3VudGVkIHVuZGVyIHtAbGluayBERVZFTE9QRVJfQVBJX1BSRUZJWH0gKGAvYXBpL2RldmVsb3Blci92MWApLiBEZXYtb25seSDigJRcbiAqIHRoZSBjYWxsZXIgKGBkZW5vLnRzYCkgcmVnaXN0ZXJzIHRoaXMgc3VyZmFjZSBvbmx5IHdoZW4gZGV2IG1vZGUgaXMgZW5hYmxlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyRGV2ZWxvcGVyUm91dGVzKGFwcDogSG9ubywgb3B0czogeyBzZXNzaW9uU2VjcmV0OiBzdHJpbmcgfSkge1xuICBjb25zdCBkZXZlbG9wZXIgPSBuZXcgSG9ubygpXG4gIGRldmVsb3Blci51c2UoJyonLCBjcmVhdGVSb290T25seU1pZGRsZXdhcmUob3B0cy5zZXNzaW9uU2VjcmV0KSlcblxuICBkZXZlbG9wZXIuZ2V0KCcvZGFlbW9uL2Nvbm5lY3Rpb25zJywgKGMpID0+XG4gICAgYy5qc29uKHsgY29ubmVjdGlvbnM6IGxpc3REYWVtb25Db25uZWN0aW9ucygpIH0pKVxuXG4gIGRldmVsb3Blci5nZXQoJy9kYWVtb24vZXZlbnRzJywgKGMpID0+IHtcbiAgICBjb25zdCBsaW1pdCA9IE51bWJlcihjLnJlcS5xdWVyeSgnbGltaXQnKSA/PyA1MClcbiAgICByZXR1cm4gYy5qc29uKHsgZXZlbnRzOiBsaXN0RGFlbW9uRXZlbnRzKE51bWJlci5pc0Zpbml0ZShsaW1pdCkgPyBsaW1pdCA6IDUwKSB9KVxuICB9KVxuXG4gIGRldmVsb3Blci5wb3N0KCcvZGFlbW9uL2Jyb2FkY2FzdCcsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgYm9keSA9IGF3YWl0IGMucmVxLmpzb24oKS5jYXRjaCgoKSA9PiBudWxsKVxuICAgIGlmICghYm9keSB8fCB0eXBlb2YgYm9keSAhPT0gJ29iamVjdCcgfHwgISgncGF5bG9hZCcgaW4gYm9keSkpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2V4cGVjdGVkIHsgcGF5bG9hZDogdW5rbm93biB9JyB9LCA0MDApXG4gICAgfVxuXG4gICAgY29uc3QgbWVzc2FnZTogRGFlbW9uTWVzc2FnZSA9IHtcbiAgICAgIHR5cGU6ICdlY2hvJyxcbiAgICAgIHBheWxvYWQ6IGJvZHkucGF5bG9hZCxcbiAgICAgIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgfVxuICAgIGNvbnN0IHNlbnQgPSBicm9hZGNhc3RUb0RhZW1vbnMobWVzc2FnZSlcbiAgICByZWNvcmREYWVtb25Ccm9hZGNhc3Qoc2VudCwgYm9keS5wYXlsb2FkKVxuICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSwgc2VudCB9KVxuICB9KVxuXG4gIGRldmVsb3Blci5wb3N0KCcvZGFlbW9uLzppZC9zZW5kJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBpZCA9IGMucmVxLnBhcmFtKCdpZCcpXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IGMucmVxLmpzb24oKS5jYXRjaCgoKSA9PiBudWxsKVxuICAgIGlmICghYm9keSB8fCB0eXBlb2YgYm9keSAhPT0gJ29iamVjdCcgfHwgISgncGF5bG9hZCcgaW4gYm9keSkpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2V4cGVjdGVkIHsgcGF5bG9hZDogdW5rbm93biB9JyB9LCA0MDApXG4gICAgfVxuXG4gICAgY29uc3QgbWVzc2FnZTogRGFlbW9uTWVzc2FnZSA9IHtcbiAgICAgIHR5cGU6ICdlY2hvJyxcbiAgICAgIHBheWxvYWQ6IGJvZHkucGF5bG9hZCxcbiAgICAgIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgfVxuICAgIGNvbnN0IHNlbnQgPSBzZW5kVG9EYWVtb24oaWQsIG1lc3NhZ2UpXG4gICAgaWYgKCFzZW50KSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdkYWVtb24gbm90IGNvbm5lY3RlZCcgfSwgNDA0KVxuICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSwgaWQgfSlcbiAgfSlcblxuICBkZXZlbG9wZXIuZ2V0KCcvZGFlbW9uL2NvbW1hbmRzJywgKGMpID0+IHtcbiAgICBjb25zdCBsaW1pdCA9IE51bWJlcihjLnJlcS5xdWVyeSgnbGltaXQnKSA/PyA1MClcbiAgICByZXR1cm4gYy5qc29uKHsgY29tbWFuZHM6IGxpc3RDb21tYW5kUmVzdWx0cyhOdW1iZXIuaXNGaW5pdGUobGltaXQpID8gbGltaXQgOiA1MCkgfSlcbiAgfSlcblxuICBkZXZlbG9wZXIucG9zdCgnL2RhZW1vbi9jb21tYW5kJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgYy5yZXEuanNvbigpLmNhdGNoKCgpID0+IG51bGwpXG4gICAgY29uc3QgY29tbWFuZCA9IHR5cGVvZiBib2R5Py5jb21tYW5kID09PSAnc3RyaW5nJyA/IGJvZHkuY29tbWFuZC50cmltKCkgOiAnJ1xuICAgIGlmICghY29tbWFuZCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZXhwZWN0ZWQgeyBjb21tYW5kOiBzdHJpbmcgfScgfSwgNDAwKVxuXG4gICAgY29uc3QgY29tbWFuZElkcyA9IGxpc3REYWVtb25Db25uZWN0aW9ucygpXG4gICAgICAubWFwKChjb25uKSA9PiBkaXNwYXRjaENvbW1hbmQoY29ubi5pZCwgY29tbWFuZCkpXG4gICAgICAuZmlsdGVyKChpZCk6IGlkIGlzIHN0cmluZyA9PiBpZCAhPT0gbnVsbClcbiAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIHNlbnQ6IGNvbW1hbmRJZHMubGVuZ3RoLCBjb21tYW5kSWRzIH0pXG4gIH0pXG5cbiAgZGV2ZWxvcGVyLnBvc3QoJy9kYWVtb24vOmlkL2NvbW1hbmQnLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IGlkID0gYy5yZXEucGFyYW0oJ2lkJylcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgYy5yZXEuanNvbigpLmNhdGNoKCgpID0+IG51bGwpXG4gICAgY29uc3QgY29tbWFuZCA9IHR5cGVvZiBib2R5Py5jb21tYW5kID09PSAnc3RyaW5nJyA/IGJvZHkuY29tbWFuZC50cmltKCkgOiAnJ1xuICAgIGlmICghY29tbWFuZCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZXhwZWN0ZWQgeyBjb21tYW5kOiBzdHJpbmcgfScgfSwgNDAwKVxuXG4gICAgY29uc3QgY29tbWFuZElkID0gZGlzcGF0Y2hDb21tYW5kKGlkLCBjb21tYW5kKVxuICAgIGlmICghY29tbWFuZElkKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdkYWVtb24gbm90IGNvbm5lY3RlZCcgfSwgNDA0KVxuICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSwgY29tbWFuZElkIH0pXG4gIH0pXG5cbiAgZGV2ZWxvcGVyLmdldCgnL2luc3RhbmNlL2FkZHJlc3NlcycsIChjKSA9PiB7XG4gICAgY29uc3QgYWRkcmVzc2VzID0gY29sbGVjdFNlcnZlckFkZHJlc3NlcygpXG4gICAgcmV0dXJuIGMuanNvbih7IG9rOiB0cnVlLCBzb3VyY2U6ICdpbnN0YW5jZScsIGFkZHJlc3NlcyB9KVxuICB9KVxuXG4gIGRldmVsb3Blci5nZXQoJy9kYWVtb24vYWRkcmVzc2VzJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBjb25uZWN0aW9ucyA9IGxpc3REYWVtb25Db25uZWN0aW9ucygpXG4gICAgY29uc3Qgc2VydmVycyA9IGF3YWl0IFByb21pc2UuYWxsKFxuICAgICAgY29ubmVjdGlvbnMubWFwKGFzeW5jIChjb25uKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgYWRkcmVzc2VzID0gYXdhaXQgcmVxdWVzdERhZW1vbkFkZHJlc3Nlcyhjb25uLmlkKVxuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBkYWVtb25JZDogY29ubi5pZCxcbiAgICAgICAgICAgIGhvc3RuYW1lOiBjb25uLmhvc3RuYW1lID8/IG51bGwsXG4gICAgICAgICAgICBhZGRyZXNzZXMsXG4gICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgZGFlbW9uSWQ6IGNvbm4uaWQsXG4gICAgICAgICAgICBob3N0bmFtZTogY29ubi5ob3N0bmFtZSA/PyBudWxsLFxuICAgICAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0pLFxuICAgIClcbiAgICByZXR1cm4gYy5qc29uKHsgc2VydmVycyB9KVxuICB9KVxuXG4gIGRldmVsb3Blci5nZXQoJy9kYWVtb24vOmlkL2FkZHJlc3NlcycsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgaWQgPSBjLnJlcS5wYXJhbSgnaWQnKVxuICAgIHRyeSB7XG4gICAgICBjb25zdCBhZGRyZXNzZXMgPSBhd2FpdCByZXF1ZXN0RGFlbW9uQWRkcmVzc2VzKGlkKVxuICAgICAgY29uc3QgY29ubiA9IGxpc3REYWVtb25Db25uZWN0aW9ucygpLmZpbmQoKGVudHJ5KSA9PiBlbnRyeS5pZCA9PT0gaWQpXG4gICAgICByZXR1cm4gYy5qc29uKHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGRhZW1vbklkOiBpZCxcbiAgICAgICAgaG9zdG5hbWU6IGNvbm4/Lmhvc3RuYW1lID8/IG51bGwsXG4gICAgICAgIGFkZHJlc3NlcyxcbiAgICAgIH0pXG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICBjb25zdCBzdGF0dXMgPSBtZXNzYWdlID09PSAnZGFlbW9uIG5vdCBjb25uZWN0ZWQnID8gNDA0IDogNTAwXG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6IG1lc3NhZ2UgfSwgc3RhdHVzKVxuICAgIH1cbiAgfSlcblxuICByZWdpc3RlckRhdGFiYXNlUm91dGVzKGRldmVsb3BlcilcblxuICBkZXZlbG9wZXIuZ2V0KCcvZXhwby9zdGF0dXMnLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IHsgcnVubmluZyB9ID0gYXdhaXQgZXhwb1RtdXhTdGF0dXMoKVxuICAgIHJldHVybiBjLmpzb24oeyBydW5uaW5nIH0pXG4gIH0pXG5cbiAgZGV2ZWxvcGVyLnBvc3QoJy9leHBvL3Jlc3RhcnQnLCAoYykgPT4ge1xuICAgIGlmICghRVhQT19VSV9TRVJWSUNFKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7XG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIGVycm9yOlxuICAgICAgICAgICAgJ2V4cG8gcmVzdGFydCB1bmF2YWlsYWJsZTogVFVSQk9QQU5FTF9VSV9TRVJWSUNFIGlzIG5vdCBzZXQgKHJ1biB1bmRlciBzeXN0ZW1kIG9yIGNvbmZpZ3VyZSBhIG1hbmFnZWQgc2VydmljZSknLFxuICAgICAgICB9LFxuICAgICAgICA1MDMsXG4gICAgICApXG4gICAgfVxuXG4gICAgbmV3IERlbm8uQ29tbWFuZCgnc3VkbycsIHtcbiAgICAgIGFyZ3M6IFsnc3lzdGVtY3RsJywgJ3Jlc3RhcnQnLCBFWFBPX1VJX1NFUlZJQ0VdLFxuICAgICAgc3RkaW46ICdudWxsJyxcbiAgICAgIHN0ZG91dDogJ251bGwnLFxuICAgICAgc3RkZXJyOiAnbnVsbCcsXG4gICAgfSkuc3Bhd24oKVxuXG4gICAgcmV0dXJuIGMuanNvbih7IG9rOiB0cnVlIH0pXG4gIH0pXG5cbiAgYXBwLnJvdXRlKERFVkVMT1BFUl9BUElfUFJFRklYLCBkZXZlbG9wZXIpXG4gIHJldHVybiBhcHBcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUFTLElBQUksUUFBUSxPQUFNO0FBQzNCLFNBQVMsd0JBQXdCLFFBQVEsdUJBQXNCO0FBQy9ELFNBQ0Usa0JBQWtCLEVBRWxCLGVBQWUsRUFDZixrQkFBa0IsRUFDbEIscUJBQXFCLEVBQ3JCLGdCQUFnQixFQUNoQixxQkFBcUIsRUFDckIsc0JBQXNCLEVBQ3RCLFlBQVksUUFDUCxrQkFBaUI7QUFDeEIsU0FBUyxzQkFBc0IsUUFBUSx3QkFBdUI7QUFDOUQsU0FBUyxzQkFBc0IsUUFBUSx1QkFBc0I7QUFDN0QsU0FBUyxlQUFlLEVBQUUsY0FBYyxRQUFRLGdCQUFlO0FBQy9ELFNBQVMsb0JBQW9CLFFBQVEsZ0JBQWU7QUFFcEQ7Ozs7Q0FJQyxHQUNELE9B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
// denoCacheMetadata=17119073920370600991,12120891821486135524