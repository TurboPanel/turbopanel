import { Hono } from 'hono';
import { broadcastToDaemons, dispatchCommand, listCommandResults, listDaemonConnections, listDaemonEvents, recordDaemonBroadcast, requestDaemonAddresses, sendToDaemon } from './daemon-hub.ts';
import { collectServerAddresses } from './server-addresses.ts';
import { DEVELOPER_API_PREFIX } from './surfaces.ts';
/**
 * Developer console surface: fleet management, diagnostics, shell, addresses.
 * Mounted under {@link DEVELOPER_API_PREFIX} (`/api/developer/v1`). Dev-only —
 * the caller (`deno.ts`) registers this surface only when dev mode is enabled.
 */ export function registerDeveloperRoutes(app) {
  const developer = new Hono();
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
  app.route(DEVELOPER_API_PREFIX, developer);
  return app;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vb3B0L3R1cmJvcGFuZWwvcGxhdGZvcm0vdHVyYm9wYW5lbC9zcmMvZGV2ZWxvcGVyLXJvdXRlcy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBIb25vIH0gZnJvbSAnaG9ubydcbmltcG9ydCB7XG4gIGJyb2FkY2FzdFRvRGFlbW9ucyxcbiAgdHlwZSBEYWVtb25NZXNzYWdlLFxuICBkaXNwYXRjaENvbW1hbmQsXG4gIGxpc3RDb21tYW5kUmVzdWx0cyxcbiAgbGlzdERhZW1vbkNvbm5lY3Rpb25zLFxuICBsaXN0RGFlbW9uRXZlbnRzLFxuICByZWNvcmREYWVtb25Ccm9hZGNhc3QsXG4gIHJlcXVlc3REYWVtb25BZGRyZXNzZXMsXG4gIHNlbmRUb0RhZW1vbixcbn0gZnJvbSAnLi9kYWVtb24taHViLnRzJ1xuaW1wb3J0IHsgY29sbGVjdFNlcnZlckFkZHJlc3NlcyB9IGZyb20gJy4vc2VydmVyLWFkZHJlc3Nlcy50cydcbmltcG9ydCB7IERFVkVMT1BFUl9BUElfUFJFRklYIH0gZnJvbSAnLi9zdXJmYWNlcy50cydcblxuLyoqXG4gKiBEZXZlbG9wZXIgY29uc29sZSBzdXJmYWNlOiBmbGVldCBtYW5hZ2VtZW50LCBkaWFnbm9zdGljcywgc2hlbGwsIGFkZHJlc3Nlcy5cbiAqIE1vdW50ZWQgdW5kZXIge0BsaW5rIERFVkVMT1BFUl9BUElfUFJFRklYfSAoYC9hcGkvZGV2ZWxvcGVyL3YxYCkuIERldi1vbmx5IOKAlFxuICogdGhlIGNhbGxlciAoYGRlbm8udHNgKSByZWdpc3RlcnMgdGhpcyBzdXJmYWNlIG9ubHkgd2hlbiBkZXYgbW9kZSBpcyBlbmFibGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJEZXZlbG9wZXJSb3V0ZXMoYXBwOiBIb25vKSB7XG4gIGNvbnN0IGRldmVsb3BlciA9IG5ldyBIb25vKClcblxuICBkZXZlbG9wZXIuZ2V0KCcvZGFlbW9uL2Nvbm5lY3Rpb25zJywgKGMpID0+XG4gICAgYy5qc29uKHsgY29ubmVjdGlvbnM6IGxpc3REYWVtb25Db25uZWN0aW9ucygpIH0pKVxuXG4gIGRldmVsb3Blci5nZXQoJy9kYWVtb24vZXZlbnRzJywgKGMpID0+IHtcbiAgICBjb25zdCBsaW1pdCA9IE51bWJlcihjLnJlcS5xdWVyeSgnbGltaXQnKSA/PyA1MClcbiAgICByZXR1cm4gYy5qc29uKHsgZXZlbnRzOiBsaXN0RGFlbW9uRXZlbnRzKE51bWJlci5pc0Zpbml0ZShsaW1pdCkgPyBsaW1pdCA6IDUwKSB9KVxuICB9KVxuXG4gIGRldmVsb3Blci5wb3N0KCcvZGFlbW9uL2Jyb2FkY2FzdCcsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgYm9keSA9IGF3YWl0IGMucmVxLmpzb24oKS5jYXRjaCgoKSA9PiBudWxsKVxuICAgIGlmICghYm9keSB8fCB0eXBlb2YgYm9keSAhPT0gJ29iamVjdCcgfHwgISgncGF5bG9hZCcgaW4gYm9keSkpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2V4cGVjdGVkIHsgcGF5bG9hZDogdW5rbm93biB9JyB9LCA0MDApXG4gICAgfVxuXG4gICAgY29uc3QgbWVzc2FnZTogRGFlbW9uTWVzc2FnZSA9IHtcbiAgICAgIHR5cGU6ICdlY2hvJyxcbiAgICAgIHBheWxvYWQ6IGJvZHkucGF5bG9hZCxcbiAgICAgIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgfVxuICAgIGNvbnN0IHNlbnQgPSBicm9hZGNhc3RUb0RhZW1vbnMobWVzc2FnZSlcbiAgICByZWNvcmREYWVtb25Ccm9hZGNhc3Qoc2VudCwgYm9keS5wYXlsb2FkKVxuICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSwgc2VudCB9KVxuICB9KVxuXG4gIGRldmVsb3Blci5wb3N0KCcvZGFlbW9uLzppZC9zZW5kJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBpZCA9IGMucmVxLnBhcmFtKCdpZCcpXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IGMucmVxLmpzb24oKS5jYXRjaCgoKSA9PiBudWxsKVxuICAgIGlmICghYm9keSB8fCB0eXBlb2YgYm9keSAhPT0gJ29iamVjdCcgfHwgISgncGF5bG9hZCcgaW4gYm9keSkpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2V4cGVjdGVkIHsgcGF5bG9hZDogdW5rbm93biB9JyB9LCA0MDApXG4gICAgfVxuXG4gICAgY29uc3QgbWVzc2FnZTogRGFlbW9uTWVzc2FnZSA9IHtcbiAgICAgIHR5cGU6ICdlY2hvJyxcbiAgICAgIHBheWxvYWQ6IGJvZHkucGF5bG9hZCxcbiAgICAgIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgfVxuICAgIGNvbnN0IHNlbnQgPSBzZW5kVG9EYWVtb24oaWQsIG1lc3NhZ2UpXG4gICAgaWYgKCFzZW50KSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdkYWVtb24gbm90IGNvbm5lY3RlZCcgfSwgNDA0KVxuICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSwgaWQgfSlcbiAgfSlcblxuICBkZXZlbG9wZXIuZ2V0KCcvZGFlbW9uL2NvbW1hbmRzJywgKGMpID0+IHtcbiAgICBjb25zdCBsaW1pdCA9IE51bWJlcihjLnJlcS5xdWVyeSgnbGltaXQnKSA/PyA1MClcbiAgICByZXR1cm4gYy5qc29uKHsgY29tbWFuZHM6IGxpc3RDb21tYW5kUmVzdWx0cyhOdW1iZXIuaXNGaW5pdGUobGltaXQpID8gbGltaXQgOiA1MCkgfSlcbiAgfSlcblxuICBkZXZlbG9wZXIucG9zdCgnL2RhZW1vbi9jb21tYW5kJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgYy5yZXEuanNvbigpLmNhdGNoKCgpID0+IG51bGwpXG4gICAgY29uc3QgY29tbWFuZCA9IHR5cGVvZiBib2R5Py5jb21tYW5kID09PSAnc3RyaW5nJyA/IGJvZHkuY29tbWFuZC50cmltKCkgOiAnJ1xuICAgIGlmICghY29tbWFuZCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZXhwZWN0ZWQgeyBjb21tYW5kOiBzdHJpbmcgfScgfSwgNDAwKVxuXG4gICAgY29uc3QgY29tbWFuZElkcyA9IGxpc3REYWVtb25Db25uZWN0aW9ucygpXG4gICAgICAubWFwKChjb25uKSA9PiBkaXNwYXRjaENvbW1hbmQoY29ubi5pZCwgY29tbWFuZCkpXG4gICAgICAuZmlsdGVyKChpZCk6IGlkIGlzIHN0cmluZyA9PiBpZCAhPT0gbnVsbClcbiAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIHNlbnQ6IGNvbW1hbmRJZHMubGVuZ3RoLCBjb21tYW5kSWRzIH0pXG4gIH0pXG5cbiAgZGV2ZWxvcGVyLnBvc3QoJy9kYWVtb24vOmlkL2NvbW1hbmQnLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IGlkID0gYy5yZXEucGFyYW0oJ2lkJylcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgYy5yZXEuanNvbigpLmNhdGNoKCgpID0+IG51bGwpXG4gICAgY29uc3QgY29tbWFuZCA9IHR5cGVvZiBib2R5Py5jb21tYW5kID09PSAnc3RyaW5nJyA/IGJvZHkuY29tbWFuZC50cmltKCkgOiAnJ1xuICAgIGlmICghY29tbWFuZCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZXhwZWN0ZWQgeyBjb21tYW5kOiBzdHJpbmcgfScgfSwgNDAwKVxuXG4gICAgY29uc3QgY29tbWFuZElkID0gZGlzcGF0Y2hDb21tYW5kKGlkLCBjb21tYW5kKVxuICAgIGlmICghY29tbWFuZElkKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdkYWVtb24gbm90IGNvbm5lY3RlZCcgfSwgNDA0KVxuICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSwgY29tbWFuZElkIH0pXG4gIH0pXG5cbiAgZGV2ZWxvcGVyLmdldCgnL2luc3RhbmNlL2FkZHJlc3NlcycsIChjKSA9PiB7XG4gICAgY29uc3QgYWRkcmVzc2VzID0gY29sbGVjdFNlcnZlckFkZHJlc3NlcygpXG4gICAgcmV0dXJuIGMuanNvbih7IG9rOiB0cnVlLCBzb3VyY2U6ICdpbnN0YW5jZScsIGFkZHJlc3NlcyB9KVxuICB9KVxuXG4gIGRldmVsb3Blci5nZXQoJy9kYWVtb24vYWRkcmVzc2VzJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBjb25uZWN0aW9ucyA9IGxpc3REYWVtb25Db25uZWN0aW9ucygpXG4gICAgY29uc3Qgc2VydmVycyA9IGF3YWl0IFByb21pc2UuYWxsKFxuICAgICAgY29ubmVjdGlvbnMubWFwKGFzeW5jIChjb25uKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgYWRkcmVzc2VzID0gYXdhaXQgcmVxdWVzdERhZW1vbkFkZHJlc3Nlcyhjb25uLmlkKVxuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBkYWVtb25JZDogY29ubi5pZCxcbiAgICAgICAgICAgIGhvc3RuYW1lOiBjb25uLmhvc3RuYW1lID8/IG51bGwsXG4gICAgICAgICAgICBhZGRyZXNzZXMsXG4gICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgZGFlbW9uSWQ6IGNvbm4uaWQsXG4gICAgICAgICAgICBob3N0bmFtZTogY29ubi5ob3N0bmFtZSA/PyBudWxsLFxuICAgICAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0pLFxuICAgIClcbiAgICByZXR1cm4gYy5qc29uKHsgc2VydmVycyB9KVxuICB9KVxuXG4gIGRldmVsb3Blci5nZXQoJy9kYWVtb24vOmlkL2FkZHJlc3NlcycsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgaWQgPSBjLnJlcS5wYXJhbSgnaWQnKVxuICAgIHRyeSB7XG4gICAgICBjb25zdCBhZGRyZXNzZXMgPSBhd2FpdCByZXF1ZXN0RGFlbW9uQWRkcmVzc2VzKGlkKVxuICAgICAgY29uc3QgY29ubiA9IGxpc3REYWVtb25Db25uZWN0aW9ucygpLmZpbmQoKGVudHJ5KSA9PiBlbnRyeS5pZCA9PT0gaWQpXG4gICAgICByZXR1cm4gYy5qc29uKHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIGRhZW1vbklkOiBpZCxcbiAgICAgICAgaG9zdG5hbWU6IGNvbm4/Lmhvc3RuYW1lID8/IG51bGwsXG4gICAgICAgIGFkZHJlc3NlcyxcbiAgICAgIH0pXG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICBjb25zdCBzdGF0dXMgPSBtZXNzYWdlID09PSAnZGFlbW9uIG5vdCBjb25uZWN0ZWQnID8gNDA0IDogNTAwXG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6IG1lc3NhZ2UgfSwgc3RhdHVzKVxuICAgIH1cbiAgfSlcblxuICBhcHAucm91dGUoREVWRUxPUEVSX0FQSV9QUkVGSVgsIGRldmVsb3BlcilcbiAgcmV0dXJuIGFwcFxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLFNBQVMsSUFBSSxRQUFRLE9BQU07QUFDM0IsU0FDRSxrQkFBa0IsRUFFbEIsZUFBZSxFQUNmLGtCQUFrQixFQUNsQixxQkFBcUIsRUFDckIsZ0JBQWdCLEVBQ2hCLHFCQUFxQixFQUNyQixzQkFBc0IsRUFDdEIsWUFBWSxRQUNQLGtCQUFpQjtBQUN4QixTQUFTLHNCQUFzQixRQUFRLHdCQUF1QjtBQUM5RCxTQUFTLG9CQUFvQixRQUFRLGdCQUFlO0FBRXBEOzs7O0NBSUMsR0FDRCxPQUFPLFNBQVMsd0JBQXdCLEdBQVM7RUFDL0MsTUFBTSxZQUFZLElBQUk7RUFFdEIsVUFBVSxHQUFHLENBQUMsdUJBQXVCLENBQUMsSUFDcEMsRUFBRSxJQUFJLENBQUM7TUFBRSxhQUFhO0lBQXdCO0VBRWhELFVBQVUsR0FBRyxDQUFDLGtCQUFrQixDQUFDO0lBQy9CLE1BQU0sUUFBUSxPQUFPLEVBQUUsR0FBRyxDQUFDLEtBQUssQ0FBQyxZQUFZO0lB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
// denoCacheMetadata=10065920532461909271,8875092416648332169