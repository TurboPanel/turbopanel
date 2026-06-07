import { upgradeWebSocket } from 'hono/deno';
import { evictDuplicateDaemons, parseDaemonMessage, pruneStaleDaemons, recordAddressesResult, recordCommandResult, recordDaemonAck, recordDaemonMessage, registerDaemon, setDaemonHostname, setDaemonNodeId, probeDaemonHostname, probeMissingHostnames, setDaemonRemoteAddress, touchDaemonInbound, unregisterDaemon } from './daemon-hub.ts';
import { DEVELOPER_WS_PATH, CLIENT_WS_PATH, DAEMON_WS_PATH } from './surfaces.ts';
let pruneTimer;
function runPruneCycle() {
  probeMissingHostnames();
  const pruned = pruneStaleDaemons();
  if (pruned.length > 0) {
    console.log(`[ws] pruned ${pruned.length} stale daemon connection(s): ${pruned.join(', ')}`);
  }
}
function ensurePruneTimer() {
  if (pruneTimer) return;
  pruneTimer = setInterval(runPruneCycle, 15_000);
}
export function registerDaemonWebSocket(app, { developerSurface = false } = {}) {
  app.get(DAEMON_WS_PATH, upgradeWebSocket((c)=>{
    const remoteAddress = c.req.header('x-real-ip')?.trim() || c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    let connId;
    let identityAddress = remoteAddress ?? '__direct__';
    let pingTimer;
    return {
      onOpen (_event, ws) {
        ensurePruneTimer();
        const conn = registerDaemon((data)=>ws.send(data), ()=>ws.close());
        connId = conn.id;
        // Caddy sets X-Real-IP for remote agents; co-located unix-socket daemons
        // have no proxy hop — collapse those under a single local slot.
        identityAddress = remoteAddress ?? '__direct__';
        setDaemonRemoteAddress(conn.id, identityAddress);
        console.log(`[ws] daemon connected: ${conn.id}${remoteAddress ? ` from ${remoteAddress}` : ''}`);
        const hello = {
          type: 'hello',
          from: 'instance',
          at: new Date().toISOString()
        };
        recordDaemonMessage(conn.id, 'out', hello);
        ws.send(JSON.stringify(hello));
        // No version push: the daemon never self-updates. Updates are
        // operator-driven (admin upgrade button / dev-sync).
        pingTimer = setInterval(()=>{
          const ping = {
            type: 'ping',
            id: crypto.randomUUID(),
            at: new Date().toISOString()
          };
          ws.send(JSON.stringify(ping));
        }, 15_000);
      },
      onMessage (event, ws) {
        const raw = typeof event.data === 'string' ? event.data : String(event.data);
        const message = parseDaemonMessage(raw);
        if (!message) {
          console.warn('[ws] ignored non-JSON message from daemon');
          return;
        }
        console.log(`[ws] from ${connId ?? 'unknown'}:`, message.type);
        if (connId) {
          touchDaemonInbound(connId);
          recordDaemonMessage(connId, 'in', message);
        }
        if (message.type === 'hello' && message.from === 'daemon' && connId) {
          if (message.hostname) setDaemonHostname(connId, message.hostname);
          if (message.nodeId) {
            connId = setDaemonNodeId(connId, message.nodeId);
          }
          const evicted = evictDuplicateDaemons(connId, {
            hostname: message.hostname,
            nodeId: message.nodeId,
            remoteAddress: identityAddress
          });
          if (evicted.length > 0) {
            console.log(`[ws] evicted ${evicted.length} duplicate connection(s) for ${message.hostname ?? message.nodeId ?? connId}`);
          }
          if (message.hostname) {
            console.log(`[ws] daemon hostname: ${message.hostname} (${connId})`);
          } else {
            probeDaemonHostname(connId);
          }
        }
        if (message.type === 'ping') {
          const pong = {
            type: 'pong',
            id: message.id,
            at: new Date().toISOString()
          };
          if (connId) recordDaemonMessage(connId, 'out', pong);
          ws.send(JSON.stringify(pong));
        }
        if (message.type === 'command-result') {
          recordCommandResult(message);
        }
        if (message.type === 'addresses-result') {
          recordAddressesResult(message);
        }
        if (message.type === 'dev-sync-result' || message.type === 'tunnel-token-result') {
          recordDaemonAck(message.id, message.ok, message.error);
        }
      },
      onClose () {
        if (pingTimer) clearInterval(pingTimer);
        if (connId) {
          unregisterDaemon(connId);
          console.log(`[ws] daemon disconnected: ${connId}`);
        }
      },
      onError (_event) {
        if (pingTimer) clearInterval(pingTimer);
        if (connId) unregisterDaemon(connId);
      }
    };
  }));
  if (developerSurface) registerStubWebSocket(app, DEVELOPER_WS_PATH, 'developer');
  registerStubWebSocket(app, CLIENT_WS_PATH, 'client');
}
/**
 * Placeholder WebSocket surface for the admin/client UIs. Today the UIs poll
 * REST; these endpoints reserve the namespace for future live streaming. They
 * accept the upgrade, greet the peer, and otherwise idle.
 */ function registerStubWebSocket(app, path, surface) {
  app.get(path, upgradeWebSocket(()=>({
      onOpen (_event, ws) {
        ws.send(JSON.stringify({
          type: 'hello',
          surface,
          at: new Date().toISOString()
        }));
      }
    })));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vb3B0L3R1cmJvcGFuZWwvcGxhdGZvcm0vdHVyYm9wYW5lbC9zcmMvZGVuby13cy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IEhvbm8gfSBmcm9tICdob25vJ1xuaW1wb3J0IHsgdXBncmFkZVdlYlNvY2tldCB9IGZyb20gJ2hvbm8vZGVubydcbmltcG9ydCB7XG4gIHR5cGUgRGFlbW9uTWVzc2FnZSxcbiAgZXZpY3REdXBsaWNhdGVEYWVtb25zLFxuICBwYXJzZURhZW1vbk1lc3NhZ2UsXG4gIHBydW5lU3RhbGVEYWVtb25zLFxuICByZWNvcmRBZGRyZXNzZXNSZXN1bHQsXG4gIHJlY29yZENvbW1hbmRSZXN1bHQsXG4gIHJlY29yZERhZW1vbkFjayxcbiAgcmVjb3JkRGFlbW9uTWVzc2FnZSxcbiAgcmVnaXN0ZXJEYWVtb24sXG4gIHNldERhZW1vbkhvc3RuYW1lLFxuICBzZXREYWVtb25Ob2RlSWQsXG4gIHByb2JlRGFlbW9uSG9zdG5hbWUsXG4gIHByb2JlTWlzc2luZ0hvc3RuYW1lcyxcbiAgc2V0RGFlbW9uUmVtb3RlQWRkcmVzcyxcbiAgdG91Y2hEYWVtb25JbmJvdW5kLFxuICB1bnJlZ2lzdGVyRGFlbW9uLFxufSBmcm9tICcuL2RhZW1vbi1odWIudHMnXG5cbmltcG9ydCB7IERFVkVMT1BFUl9XU19QQVRILCBDTElFTlRfV1NfUEFUSCwgREFFTU9OX1dTX1BBVEggfSBmcm9tICcuL3N1cmZhY2VzLnRzJ1xuXG5sZXQgcHJ1bmVUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgdW5kZWZpbmVkXG5cbmZ1bmN0aW9uIHJ1blBydW5lQ3ljbGUoKTogdm9pZCB7XG4gIHByb2JlTWlzc2luZ0hvc3RuYW1lcygpXG4gIGNvbnN0IHBydW5lZCA9IHBydW5lU3RhbGVEYWVtb25zKClcbiAgaWYgKHBydW5lZC5sZW5ndGggPiAwKSB7XG4gICAgY29uc29sZS5sb2coYFt3c10gcHJ1bmVkICR7cHJ1bmVkLmxlbmd0aH0gc3RhbGUgZGFlbW9uIGNvbm5lY3Rpb24ocyk6ICR7cHJ1bmVkLmpvaW4oJywgJyl9YClcbiAgfVxufVxuXG5mdW5jdGlvbiBlbnN1cmVQcnVuZVRpbWVyKCk6IHZvaWQge1xuICBpZiAocHJ1bmVUaW1lcikgcmV0dXJuXG4gIHBydW5lVGltZXIgPSBzZXRJbnRlcnZhbChydW5QcnVuZUN5Y2xlLCAxNV8wMDApXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlckRhZW1vbldlYlNvY2tldChhcHA6IEhvbm8sIHsgZGV2ZWxvcGVyU3VyZmFjZSA9IGZhbHNlIH06IHsgZGV2ZWxvcGVyU3VyZmFjZT86IGJvb2xlYW4gfSA9IHt9LCkge1xuICBhcHAuZ2V0KFxuICAgIERBRU1PTl9XU19QQVRILFxuICAgIHVwZ3JhZGVXZWJTb2NrZXQoKGMpID0+IHtcbiAgICAgIGNvbnN0IHJlbW90ZUFkZHJlc3MgPSBjLnJlcS5oZWFkZXIoJ3gtcmVhbC1pcCcpPy50cmltKCkgfHxcbiAgICAgICAgYy5yZXEuaGVhZGVyKCd4LWZvcndhcmRlZC1mb3InKT8uc3BsaXQoJywnKVswXT8udHJpbSgpXG4gICAgICBsZXQgY29ubklkOiBzdHJpbmcgfCB1bmRlZmluZWRcbiAgICAgIGxldCBpZGVudGl0eUFkZHJlc3MgPSByZW1vdGVBZGRyZXNzID8/ICdfX2RpcmVjdF9fJ1xuICAgICAgbGV0IHBpbmdUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgdW5kZWZpbmVkXG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9uT3BlbihfZXZlbnQsIHdzKSB7XG4gICAgICAgICAgZW5zdXJlUHJ1bmVUaW1lcigpXG4gICAgICAgICAgY29uc3QgY29ubiA9IHJlZ2lzdGVyRGFlbW9uKFxuICAgICAgICAgICAgKGRhdGEpID0+IHdzLnNlbmQoZGF0YSksXG4gICAgICAgICAgICAoKSA9PiB3cy5jbG9zZSgpLFxuICAgICAgICAgIClcbiAgICAgICAgICBjb25uSWQgPSBjb25uLmlkXG4gICAgICAgICAgLy8gQ2FkZHkgc2V0cyBYLVJlYWwtSVAgZm9yIHJlbW90ZSBhZ2VudHM7IGNvLWxvY2F0ZWQgdW5peC1zb2NrZXQgZGFlbW9uc1xuICAgICAgICAgIC8vIGhhdmUgbm8gcHJveHkgaG9wIOKAlCBjb2xsYXBzZSB0aG9zZSB1bmRlciBhIHNpbmdsZSBsb2NhbCBzbG90LlxuICAgICAgICAgIGlkZW50aXR5QWRkcmVzcyA9IHJlbW90ZUFkZHJlc3MgPz8gJ19fZGlyZWN0X18nXG4gICAgICAgICAgc2V0RGFlbW9uUmVtb3RlQWRkcmVzcyhjb25uLmlkLCBpZGVudGl0eUFkZHJlc3MpXG4gICAgICAgICAgY29uc29sZS5sb2coXG4gICAgICAgICAgICBgW3dzXSBkYWVtb24gY29ubmVjdGVkOiAke2Nvbm4uaWR9JHtcbiAgICAgICAgICAgICAgcmVtb3RlQWRkcmVzcyA/IGAgZnJvbSAke3JlbW90ZUFkZHJlc3N9YCA6ICcnXG4gICAgICAgICAgICB9YCxcbiAgICAgICAgICApXG5cbiAgICAgICAgICBjb25zdCBoZWxsbzogRGFlbW9uTWVzc2FnZSA9IHtcbiAgICAgICAgICAgIHR5cGU6ICdoZWxsbycsXG4gICAgICAgICAgICBmcm9tOiAnaW5zdGFuY2UnLFxuICAgICAgICAgICAgYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgICB9XG4gICAgICAgICAgcmVjb3JkRGFlbW9uTWVzc2FnZShjb25uLmlkLCAnb3V0JywgaGVsbG8pXG4gICAgICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeShoZWxsbykpXG5cbiAgICAgICAgICAvLyBObyB2ZXJzaW9uIHB1c2g6IHRoZSBkYWVtb24gbmV2ZXIgc2VsZi11cGRhdGVzLiBVcGRhdGVzIGFyZVxuICAgICAgICAgIC8vIG9wZXJhdG9yLWRyaXZlbiAoYWRtaW4gdXBncmFkZSBidXR0b24gLyBkZXYtc3luYykuXG5cbiAgICAgICAgICBwaW5nVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBwaW5nOiBEYWVtb25NZXNzYWdlID0ge1xuICAgICAgICAgICAgICB0eXBlOiAncGluZycsXG4gICAgICAgICAgICAgIGlkOiBjcnlwdG8ucmFuZG9tVVVJRCgpLFxuICAgICAgICAgICAgICBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeShwaW5nKSlcbiAgICAgICAgICB9LCAxNV8wMDApXG4gICAgICAgIH0sXG5cbiAgICAgICAgb25NZXNzYWdlKGV2ZW50LCB3cykge1xuICAgICAgICAgIGNvbnN0IHJhdyA9IHR5cGVvZiBldmVudC5kYXRhID09PSAnc3RyaW5nJ1xuICAgICAgICAgICAgPyBldmVudC5kYXRhXG4gICAgICAgICAgICA6IFN0cmluZyhldmVudC5kYXRhKVxuICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBwYXJzZURhZW1vbk1lc3NhZ2UocmF3KVxuICAgICAgICAgIGlmICghbWVzc2FnZSkge1xuICAgICAgICAgICAgY29uc29sZS53YXJuKCdbd3NdIGlnbm9yZWQgbm9uLUpTT04gbWVzc2FnZSBmcm9tIGRhZW1vbicpXG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zb2xlLmxvZyhgW3dzXSBmcm9tICR7Y29ubklkID8/ICd1bmtub3duJ306YCwgbWVzc2FnZS50eXBlKVxuICAgICAgICAgIGlmIChjb25uSWQpIHtcbiAgICAgICAgICAgIHRvdWNoRGFlbW9uSW5ib3VuZChjb25uSWQpXG4gICAgICAgICAgICByZWNvcmREYWVtb25NZXNzYWdlKGNvbm5JZCwgJ2luJywgbWVzc2FnZSlcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAobWVzc2FnZS50eXBlID09PSAnaGVsbG8nICYmIG1lc3NhZ2UuZnJvbSA9PT0gJ2RhZW1vbicgJiYgY29ubklkKSB7XG4gICAgICAgICAgICBpZiAobWVzc2FnZS5ob3N0bmFtZSkgc2V0RGFlbW9uSG9zdG5hbWUoY29ubklkLCBtZXNzYWdlLmhvc3RuYW1lKVxuICAgICAgICAgICAgaWYgKG1lc3NhZ2Uubm9kZUlkKSB7XG4gICAgICAgICAgICAgIGNvbm5JZCA9IHNldERhZW1vbk5vZGVJZChjb25uSWQsIG1lc3NhZ2Uubm9kZUlkKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgZXZpY3RlZCA9IGV2aWN0RHVwbGljYXRlRGFlbW9ucyhjb25uSWQsIHtcbiAgICAgICAgICAgICAgaG9zdG5hbWU6IG1lc3NhZ2UuaG9zdG5hbWUsXG4gICAgICAgICAgICAgIG5vZGVJZDogbWVzc2FnZS5ub2RlSWQsXG4gICAgICAgICAgICAgIHJlbW90ZUFkZHJlc3M6IGlkZW50aXR5QWRkcmVzcyxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICBpZiAoZXZpY3RlZC5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICAgICAgICAgIGBbd3NdIGV2aWN0ZWQgJHtldmljdGVkLmxlbmd0aH0gZHVwbGljYXRlIGNvbm5lY3Rpb24ocykgZm9yICR7XG4gICAgICAgICAgICAgICAgICBtZXNzYWdlLmhvc3RuYW1lID8/IG1lc3NhZ2Uubm9kZUlkID8/IGNvbm5JZFxuICAgICAgICAgICAgICAgIH1gLFxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAobWVzc2FnZS5ob3N0bmFtZSkge1xuICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgW3dzXSBkYWVtb24gaG9zdG5hbWU6ICR7bWVzc2FnZS5ob3N0bmFtZX0gKCR7Y29ubklkfSlgKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgcHJvYmVEYWVtb25Ib3N0bmFtZShjb25uSWQpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ3BpbmcnKSB7XG4gICAgICAgICAgICBjb25zdCBwb25nOiBEYWVtb25NZXNzYWdlID0ge1xuICAgICAgICAgICAgICB0eXBlOiAncG9uZycsXG4gICAgICAgICAgICAgIGlkOiBtZXNzYWdlLmlkLFxuICAgICAgICAgICAgICBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGNvbm5JZCkgcmVjb3JkRGFlbW9uTWVzc2FnZShjb25uSWQsICdvdXQnLCBwb25nKVxuICAgICAgICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeShwb25nKSlcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAobWVzc2FnZS50eXBlID09PSAnY29tbWFuZC1yZXN1bHQnKSB7XG4gICAgICAgICAgICByZWNvcmRDb21tYW5kUmVzdWx0KG1lc3NhZ2UpXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ2FkZHJlc3Nlcy1yZXN1bHQnKSB7XG4gICAgICAgICAgICByZWNvcmRBZGRyZXNzZXNSZXN1bHQobWVzc2FnZSlcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICBtZXNzYWdlLnR5cGUgPT09ICdkZXYtc3luYy1yZXN1bHQnIHx8XG4gICAgICAgICAgICBtZXNzYWdlLnR5cGUgPT09ICd0dW5uZWwtdG9rZW4tcmVzdWx0J1xuICAgICAgICAgICkge1xuICAgICAgICAgICAgcmVjb3JkRGFlbW9uQWNrKG1lc3NhZ2UuaWQsIG1lc3NhZ2Uub2ssIG1lc3NhZ2UuZXJyb3IpXG4gICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIG9uQ2xvc2UoKSB7XG4gICAgICAgICAgaWYgKHBpbmdUaW1lcikgY2xlYXJJbnRlcnZhbChwaW5nVGltZXIpXG4gICAgICAgICAgaWYgKGNvbm5JZCkge1xuICAgICAgICAgICAgdW5yZWdpc3RlckRhZW1vbihjb25uSWQpXG4gICAgICAgICAgICBjb25zb2xlLmxvZyhgW3dzXSBkYWVtb24gZGlzY29ubmVjdGVkOiAke2Nvbm5JZH1gKVxuICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBvbkVycm9yKF9ldmVudCkge1xuICAgICAgICAgIGlmIChwaW5nVGltZXIpIGNsZWFySW50ZXJ2YWwocGluZ1RpbWVyKVxuICAgICAgICAgIGlmIChjb25uSWQpIHVucmVnaXN0ZXJEYWVtb24oY29ubklkKVxuICAgICAgICB9LFxuICAgICAgfVxuICAgIH0pLFxuICApXG5cbiAgaWYgKGRldmVsb3BlclN1cmZhY2UpIHJlZ2lzdGVyU3R1YldlYlNvY2tldChhcHAsIERFVkVMT1BFUl9XU19QQVRILCAnZGV2ZWxvcGVyJylcbiAgcmVnaXN0ZXJTdHViV2ViU29ja2V0KGFwcCwgQ0xJRU5UX1dTX1BBVEgsICdjbGllbnQnKVxufVxuXG4vKipcbiAqIFBsYWNlaG9sZGVyIFdlYlNvY2tldCBzdXJmYWNlIGZvciB0aGUgYWRtaW4vY2xpZW50IFVJcy4gVG9kYXkgdGhlIFVJcyBwb2xsXG4gKiBSRVNUOyB0aGVzZSBlbmRwb2ludHMgcmVzZXJ2ZSB0aGUgbmFtZXNwYWNlIGZvciBmdXR1cmUgbGl2ZSBzdHJlYW1pbmcuIFRoZXlcbiAqIGFjY2VwdCB0aGUgdXBncmFkZSwgZ3JlZXQgdGhlIHBlZXIsIGFuZCBvdGhlcndpc2UgaWRsZS5cbiAqL1xuZnVuY3Rpb24gcmVnaXN0ZXJTdHViV2ViU29ja2V0KGFwcDogSG9ubywgcGF0aDogc3RyaW5nLCBzdXJmYWNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgYXBwLmdldChcbiAgICBwYXRoLFxuICAgIHVwZ3JhZGVXZWJTb2NrZXQoKCkgPT4gKHtcbiAgICAgIG9uT3BlbihfZXZlbnQsIHdzKSB7XG4gICAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIHR5cGU6ICdoZWxsbycsXG4gICAgICAgICAgc3VyZmFjZSxcbiAgICAgICAgICBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICB9KSlcbiAgICAgIH0sXG4gICAgfSkpLFxu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
// denoCacheMetadata=1627533251698859891,14834962453105659932