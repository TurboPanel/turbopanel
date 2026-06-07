import { Hono } from 'hono';
import { broadcastToDaemons, dispatchCommand, listCommandResults, listDaemonConnections, listDaemonEvents, recordDaemonBroadcast, requestDaemonAddresses, sendToDaemon } from './daemon-hub.ts';
import { collectServerAddresses } from './server-addresses.ts';
import { ADMIN_API_PREFIX } from './surfaces.ts';
/**
 * Admin UI surface: fleet management, diagnostics, shell, addresses.
 * Mounted under {@link ADMIN_API_PREFIX} (`/api/admin/v1`).
 */ export function registerAdminRoutes(app) {
  const admin = new Hono();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vb3B0L3R1cmJvcGFuZWwvcGxhdGZvcm0vdHVyYm9wYW5lbC9zcmMvYWRtaW4tcm91dGVzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IEhvbm8gfSBmcm9tICdob25vJ1xuaW1wb3J0IHtcbiAgYnJvYWRjYXN0VG9EYWVtb25zLFxuICB0eXBlIERhZW1vbk1lc3NhZ2UsXG4gIGRpc3BhdGNoQ29tbWFuZCxcbiAgbGlzdENvbW1hbmRSZXN1bHRzLFxuICBsaXN0RGFlbW9uQ29ubmVjdGlvbnMsXG4gIGxpc3REYWVtb25FdmVudHMsXG4gIHJlY29yZERhZW1vbkJyb2FkY2FzdCxcbiAgcmVxdWVzdERhZW1vbkFkZHJlc3NlcyxcbiAgc2VuZFRvRGFlbW9uLFxufSBmcm9tICcuL2RhZW1vbi1odWIudHMnXG5pbXBvcnQgeyBjb2xsZWN0U2VydmVyQWRkcmVzc2VzIH0gZnJvbSAnLi9zZXJ2ZXItYWRkcmVzc2VzLnRzJ1xuaW1wb3J0IHsgQURNSU5fQVBJX1BSRUZJWCB9IGZyb20gJy4vc3VyZmFjZXMudHMnXG5cbi8qKlxuICogQWRtaW4gVUkgc3VyZmFjZTogZmxlZXQgbWFuYWdlbWVudCwgZGlhZ25vc3RpY3MsIHNoZWxsLCBhZGRyZXNzZXMuXG4gKiBNb3VudGVkIHVuZGVyIHtAbGluayBBRE1JTl9BUElfUFJFRklYfSAoYC9hcGkvYWRtaW4vdjFgKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyQWRtaW5Sb3V0ZXMoYXBwOiBIb25vKSB7XG4gIGNvbnN0IGFkbWluID0gbmV3IEhvbm8oKVxuXG4gIGFkbWluLmdldCgnL2RhZW1vbi9jb25uZWN0aW9ucycsIChjKSA9PlxuICAgIGMuanNvbih7IGNvbm5lY3Rpb25zOiBsaXN0RGFlbW9uQ29ubmVjdGlvbnMoKSB9KSlcblxuICBhZG1pbi5nZXQoJy9kYWVtb24vZXZlbnRzJywgKGMpID0+IHtcbiAgICBjb25zdCBsaW1pdCA9IE51bWJlcihjLnJlcS5xdWVyeSgnbGltaXQnKSA/PyA1MClcbiAgICByZXR1cm4gYy5qc29uKHsgZXZlbnRzOiBsaXN0RGFlbW9uRXZlbnRzKE51bWJlci5pc0Zpbml0ZShsaW1pdCkgPyBsaW1pdCA6IDUwKSB9KVxuICB9KVxuXG4gIGFkbWluLnBvc3QoJy9kYWVtb24vYnJvYWRjYXN0JywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgYy5yZXEuanNvbigpLmNhdGNoKCgpID0+IG51bGwpXG4gICAgaWYgKCFib2R5IHx8IHR5cGVvZiBib2R5ICE9PSAnb2JqZWN0JyB8fCAhKCdwYXlsb2FkJyBpbiBib2R5KSkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZXhwZWN0ZWQgeyBwYXlsb2FkOiB1bmtub3duIH0nIH0sIDQwMClcbiAgICB9XG5cbiAgICBjb25zdCBtZXNzYWdlOiBEYWVtb25NZXNzYWdlID0ge1xuICAgICAgdHlwZTogJ2VjaG8nLFxuICAgICAgcGF5bG9hZDogYm9keS5wYXlsb2FkLFxuICAgICAgYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICB9XG4gICAgY29uc3Qgc2VudCA9IGJyb2FkY2FzdFRvRGFlbW9ucyhtZXNzYWdlKVxuICAgIHJlY29yZERhZW1vbkJyb2FkY2FzdChzZW50LCBib2R5LnBheWxvYWQpXG4gICAgcmV0dXJuIGMuanNvbih7IG9rOiB0cnVlLCBzZW50IH0pXG4gIH0pXG5cbiAgYWRtaW4ucG9zdCgnL2RhZW1vbi86aWQvc2VuZCcsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgaWQgPSBjLnJlcS5wYXJhbSgnaWQnKVxuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCBjLnJlcS5qc29uKCkuY2F0Y2goKCkgPT4gbnVsbClcbiAgICBpZiAoIWJvZHkgfHwgdHlwZW9mIGJvZHkgIT09ICdvYmplY3QnIHx8ICEoJ3BheWxvYWQnIGluIGJvZHkpKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdleHBlY3RlZCB7IHBheWxvYWQ6IHVua25vd24gfScgfSwgNDAwKVxuICAgIH1cblxuICAgIGNvbnN0IG1lc3NhZ2U6IERhZW1vbk1lc3NhZ2UgPSB7XG4gICAgICB0eXBlOiAnZWNobycsXG4gICAgICBwYXlsb2FkOiBib2R5LnBheWxvYWQsXG4gICAgICBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIH1cbiAgICBjb25zdCBzZW50ID0gc2VuZFRvRGFlbW9uKGlkLCBtZXNzYWdlKVxuICAgIGlmICghc2VudCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZGFlbW9uIG5vdCBjb25uZWN0ZWQnIH0sIDQwNClcbiAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIGlkIH0pXG4gIH0pXG5cbiAgYWRtaW4uZ2V0KCcvZGFlbW9uL2NvbW1hbmRzJywgKGMpID0+IHtcbiAgICBjb25zdCBsaW1pdCA9IE51bWJlcihjLnJlcS5xdWVyeSgnbGltaXQnKSA/PyA1MClcbiAgICByZXR1cm4gYy5qc29uKHsgY29tbWFuZHM6IGxpc3RDb21tYW5kUmVzdWx0cyhOdW1iZXIuaXNGaW5pdGUobGltaXQpID8gbGltaXQgOiA1MCkgfSlcbiAgfSlcblxuICBhZG1pbi5wb3N0KCcvZGFlbW9uL2NvbW1hbmQnLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCBjLnJlcS5qc29uKCkuY2F0Y2goKCkgPT4gbnVsbClcbiAgICBjb25zdCBjb21tYW5kID0gdHlwZW9mIGJvZHk/LmNvbW1hbmQgPT09ICdzdHJpbmcnID8gYm9keS5jb21tYW5kLnRyaW0oKSA6ICcnXG4gICAgaWYgKCFjb21tYW5kKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdleHBlY3RlZCB7IGNvbW1hbmQ6IHN0cmluZyB9JyB9LCA0MDApXG5cbiAgICBjb25zdCBjb21tYW5kSWRzID0gbGlzdERhZW1vbkNvbm5lY3Rpb25zKClcbiAgICAgIC5tYXAoKGNvbm4pID0+IGRpc3BhdGNoQ29tbWFuZChjb25uLmlkLCBjb21tYW5kKSlcbiAgICAgIC5maWx0ZXIoKGlkKTogaWQgaXMgc3RyaW5nID0+IGlkICE9PSBudWxsKVxuICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSwgc2VudDogY29tbWFuZElkcy5sZW5ndGgsIGNvbW1hbmRJZHMgfSlcbiAgfSlcblxuICBhZG1pbi5wb3N0KCcvZGFlbW9uLzppZC9jb21tYW5kJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBpZCA9IGMucmVxLnBhcmFtKCdpZCcpXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IGMucmVxLmpzb24oKS5jYXRjaCgoKSA9PiBudWxsKVxuICAgIGNvbnN0IGNvbW1hbmQgPSB0eXBlb2YgYm9keT8uY29tbWFuZCA9PT0gJ3N0cmluZycgPyBib2R5LmNvbW1hbmQudHJpbSgpIDogJydcbiAgICBpZiAoIWNvbW1hbmQpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2V4cGVjdGVkIHsgY29tbWFuZDogc3RyaW5nIH0nIH0sIDQwMClcblxuICAgIGNvbnN0IGNvbW1hbmRJZCA9IGRpc3BhdGNoQ29tbWFuZChpZCwgY29tbWFuZClcbiAgICBpZiAoIWNvbW1hbmRJZCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZGFlbW9uIG5vdCBjb25uZWN0ZWQnIH0sIDQwNClcbiAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIGNvbW1hbmRJZCB9KVxuICB9KVxuXG4gIGFkbWluLmdldCgnL2luc3RhbmNlL2FkZHJlc3NlcycsIChjKSA9PiB7XG4gICAgY29uc3QgYWRkcmVzc2VzID0gY29sbGVjdFNlcnZlckFkZHJlc3NlcygpXG4gICAgcmV0dXJuIGMuanNvbih7IG9rOiB0cnVlLCBzb3VyY2U6ICdpbnN0YW5jZScsIGFkZHJlc3NlcyB9KVxuICB9KVxuXG4gIGFkbWluLmdldCgnL2RhZW1vbi9hZGRyZXNzZXMnLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IGNvbm5lY3Rpb25zID0gbGlzdERhZW1vbkNvbm5lY3Rpb25zKClcbiAgICBjb25zdCBzZXJ2ZXJzID0gYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICBjb25uZWN0aW9ucy5tYXAoYXN5bmMgKGNvbm4pID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBhZGRyZXNzZXMgPSBhd2FpdCByZXF1ZXN0RGFlbW9uQWRkcmVzc2VzKGNvbm4uaWQpXG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGRhZW1vbklkOiBjb25uLmlkLFxuICAgICAgICAgICAgaG9zdG5hbWU6IGNvbm4uaG9zdG5hbWUgPz8gbnVsbCxcbiAgICAgICAgICAgIGFkZHJlc3NlcyxcbiAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBkYWVtb25JZDogY29ubi5pZCxcbiAgICAgICAgICAgIGhvc3RuYW1lOiBjb25uLmhvc3RuYW1lID8/IG51bGwsXG4gICAgICAgICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSksXG4gICAgKVxuICAgIHJldHVybiBjLmpzb24oeyBzZXJ2ZXJzIH0pXG4gIH0pXG5cbiAgYWRtaW4uZ2V0KCcvZGFlbW9uLzppZC9hZGRyZXNzZXMnLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IGlkID0gYy5yZXEucGFyYW0oJ2lkJylcbiAgICB0cnkge1xuICAgICAgY29uc3QgYWRkcmVzc2VzID0gYXdhaXQgcmVxdWVzdERhZW1vbkFkZHJlc3NlcyhpZClcbiAgICAgIGNvbnN0IGNvbm4gPSBsaXN0RGFlbW9uQ29ubmVjdGlvbnMoKS5maW5kKChlbnRyeSkgPT4gZW50cnkuaWQgPT09IGlkKVxuICAgICAgcmV0dXJuIGMuanNvbih7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICBkYWVtb25JZDogaWQsXG4gICAgICAgIGhvc3RuYW1lOiBjb25uPy5ob3N0bmFtZSA/PyBudWxsLFxuICAgICAgICBhZGRyZXNzZXMsXG4gICAgICB9KVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgY29uc3Qgc3RhdHVzID0gbWVzc2FnZSA9PT0gJ2RhZW1vbiBub3QgY29ubmVjdGVkJyA/IDQwNCA6IDUwMFxuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiBtZXNzYWdlIH0sIHN0YXR1cylcbiAgICB9XG4gIH0pXG5cbiAgYXBwLnJvdXRlKEFETUlOX0FQSV9QUkVGSVgsIGFkbWluKVxuICByZXR1cm4gYXBwXG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsU0FBUyxJQUFJLFFBQVEsT0FBTTtBQUMzQixTQUNFLGtCQUFrQixFQUVsQixlQUFlLEVBQ2Ysa0JBQWtCLEVBQ2xCLHFCQUFxQixFQUNyQixnQkFBZ0IsRUFDaEIscUJBQXFCLEVBQ3JCLHNCQUFzQixFQUN0QixZQUFZLFFBQ1Asa0JBQWlCO0FBQ3hCLFNBQVMsc0JBQXNCLFFBQVEsd0JBQXVCO0FBQzlELFNBQVMsZ0JBQWdCLFFBQVEsZ0JBQWU7QUFFaEQ7OztDQUdDLEdBQ0QsT0FBTyxTQUFTLG9CQUFvQixHQUFTO0VBQzNDLE1BQU0sUUFBUSxJQUFJO0VBRWxCLE1BQU0sR0FBRyxDQUFDLHVCQUF1QixDQUFDLElBQ2hDLEVBQUUsSUFBSSxDQUFDO01BQUUsYUFBYTtJQUF3QjtFQUVoRCxNQUFNLEdBQUcsQ0FBQyxrQkFBa0IsQ0FBQztJQUMzQixNQUFNLFFBQVEsT0FBTyxFQUFFLEdBQUcsQ0FBQyxLQUFLLENBQUMsWUFBWTtJQUM3QyxPQUFPLEVBQUUsSUFBSSxDQUFDO01BQUUsUUFBUSxpQkFBaUIsT0FBTyxRQUFRLENBQUMsU0FBUyxRQUFRO0lBQUk7RUFDaEY7RUFFQSxNQUFNLElBQUksQ0FBQyxxQkFBcUIsT0FBTztJQUNyQyxNQUFNLE9BQU8sTUFBTSxFQUFFLEdBQUcsQ0FBQyxJQUFJLEdBQUcsS0FBSyxDQUFDLElBQU07SUFDNUMs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
// denoCacheMetadata=7682157497150945145,7782828419975341952