import { upgradeWebSocket } from 'hono/deno';
import { resolveRootSession } from './auth/middleware.ts';
import { evictDuplicateDaemons, parseDaemonMessage, pruneStaleDaemons, recordAddressesResult, recordCommandResult, recordDaemonAck, recordDaemonMessage, registerDaemon, setDaemonHostname, setDaemonServerId, probeDaemonHostname, probeMissingHostnames, setDaemonRemoteAddress, touchDaemonInbound, unregisterDaemon } from './daemon-hub.ts';
import { resolveServerId } from './server-registry.ts';
import { resizeExpoTmuxPane, sendExpoKeys, streamExpoTmuxPty } from './expo-pty.ts';
import { CLIENT_WS_PATH, DAEMON_WS_PATH, DEVELOPER_EXPO_PTY_WS_PATH, DEVELOPER_WS_PATH } from './surfaces.ts';
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
export function registerDaemonWebSocket(app, { developerSurface = false, db, sessionSecret } = {}) {
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
          const socketId = connId;
          void (async ()=>{
            if (message.hostname) setDaemonHostname(socketId, message.hostname);
            let serverId;
            if (db) {
              try {
                serverId = await resolveServerId(db, {
                  serverId: message.serverId,
                  machineId: message.machineId,
                  hostname: message.hostname
                });
                connId = setDaemonServerId(socketId, serverId);
              } catch (err) {
                console.error('[ws] failed to resolve server id:', err);
              }
            } else {
              console.warn('[ws] no database configured — server id not assigned');
            }
            const activeId = connId ?? socketId;
            const evicted = evictDuplicateDaemons(activeId, {
              hostname: message.hostname,
              serverId,
              remoteAddress: identityAddress
            });
            if (evicted.length > 0) {
              console.log(`[ws] evicted ${evicted.length} duplicate connection(s) for ${serverId ?? message.hostname ?? activeId}`);
            }
            if (serverId) {
              const ack = {
                type: 'hello',
                from: 'instance',
                serverId,
                at: new Date().toISOString()
              };
              recordDaemonMessage(activeId, 'out', ack);
              ws.send(JSON.stringify(ack));
              console.log(`[ws] daemon server id: ${serverId} (${activeId})`);
            }
            if (message.hostname) {
              console.log(`[ws] daemon hostname: ${message.hostname} (${activeId})`);
            } else {
              probeDaemonHostname(activeId);
            }
          })();
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
  if (developerSurface) {
    registerStubWebSocket(app, DEVELOPER_WS_PATH, 'developer');
    app.get(DEVELOPER_EXPO_PTY_WS_PATH, async (c, next)=>{
      if (!sessionSecret) {
        return c.json({
          ok: false,
          error: 'Unauthorized'
        }, 401);
      }
      const session = await resolveRootSession(c, sessionSecret, db);
      if (!session) {
        return c.json({
          ok: false,
          error: 'Unauthorized'
        }, 401);
      }
      await next();
    }, upgradeWebSocket(()=>{
      let cleanup;
      let streamStarted = false;
      const clampSize = (cols, rows)=>({
          cols: Math.max(2, Math.min(500, Math.floor(Number(cols)))),
          rows: Math.max(1, Math.min(200, Math.floor(Number(rows))))
        });
      return {
        onOpen (_event, _ws) {
        // Wait for client log-panel dimensions before streaming.
        },
        onMessage (event, ws) {
          const raw = typeof event.data === 'string' ? event.data : String(event.data);
          try {
            const parsed = JSON.parse(raw);
            if (parsed.type === 'resize') {
              const size = clampSize(parsed.cols, parsed.rows);
              if (!Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
              void (async ()=>{
                await resizeExpoTmuxPane(size.cols, size.rows);
                if (!streamStarted) {
                  streamStarted = true;
                  cleanup = streamExpoTmuxPty({
                    send: (data)=>ws.send(data),
                    close: ()=>ws.close()
                  }, size);
                }
              })();
            }
            if (parsed.type === 'input' && typeof parsed.data === 'string') {
              void sendExpoKeys(parsed.data);
            }
          } catch  {
          // ignore malformed frames
          }
        },
        onClose () {
          cleanup?.();
        },
        onError () {
          cleanup?.();
        }
      };
    }));
  }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vb3B0L3R1cmJvcGFuZWwvcGxhdGZvcm0vdHVyYm9wYW5lbC9zcmMvZGVuby13cy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IEhvbm8gfSBmcm9tICdob25vJ1xuaW1wb3J0IHsgdXBncmFkZVdlYlNvY2tldCB9IGZyb20gJ2hvbm8vZGVubydcbmltcG9ydCB7IHJlc29sdmVSb290U2Vzc2lvbiB9IGZyb20gJy4vYXV0aC9taWRkbGV3YXJlLnRzJ1xuaW1wb3J0IHtcbiAgdHlwZSBEYWVtb25NZXNzYWdlLFxuICBldmljdER1cGxpY2F0ZURhZW1vbnMsXG4gIHBhcnNlRGFlbW9uTWVzc2FnZSxcbiAgcHJ1bmVTdGFsZURhZW1vbnMsXG4gIHJlY29yZEFkZHJlc3Nlc1Jlc3VsdCxcbiAgcmVjb3JkQ29tbWFuZFJlc3VsdCxcbiAgcmVjb3JkRGFlbW9uQWNrLFxuICByZWNvcmREYWVtb25NZXNzYWdlLFxuICByZWdpc3RlckRhZW1vbixcbiAgc2V0RGFlbW9uSG9zdG5hbWUsXG4gIHNldERhZW1vblNlcnZlcklkLFxuICBwcm9iZURhZW1vbkhvc3RuYW1lLFxuICBwcm9iZU1pc3NpbmdIb3N0bmFtZXMsXG4gIHNldERhZW1vblJlbW90ZUFkZHJlc3MsXG4gIHRvdWNoRGFlbW9uSW5ib3VuZCxcbiAgdW5yZWdpc3RlckRhZW1vbixcbn0gZnJvbSAnLi9kYWVtb24taHViLnRzJ1xuaW1wb3J0IHR5cGUgeyBEYiB9IGZyb20gJy4vZGIudHMnXG5pbXBvcnQgeyByZXNvbHZlU2VydmVySWQgfSBmcm9tICcuL3NlcnZlci1yZWdpc3RyeS50cydcblxuaW1wb3J0IHsgcmVzaXplRXhwb1RtdXhQYW5lLCBzZW5kRXhwb0tleXMsIHN0cmVhbUV4cG9UbXV4UHR5IH0gZnJvbSAnLi9leHBvLXB0eS50cydcbmltcG9ydCB7XG4gIENMSUVOVF9XU19QQVRILFxuICBEQUVNT05fV1NfUEFUSCxcbiAgREVWRUxPUEVSX0VYUE9fUFRZX1dTX1BBVEgsXG4gIERFVkVMT1BFUl9XU19QQVRILFxufSBmcm9tICcuL3N1cmZhY2VzLnRzJ1xuXG5sZXQgcHJ1bmVUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgdW5kZWZpbmVkXG5cbmZ1bmN0aW9uIHJ1blBydW5lQ3ljbGUoKTogdm9pZCB7XG4gIHByb2JlTWlzc2luZ0hvc3RuYW1lcygpXG4gIGNvbnN0IHBydW5lZCA9IHBydW5lU3RhbGVEYWVtb25zKClcbiAgaWYgKHBydW5lZC5sZW5ndGggPiAwKSB7XG4gICAgY29uc29sZS5sb2coYFt3c10gcHJ1bmVkICR7cHJ1bmVkLmxlbmd0aH0gc3RhbGUgZGFlbW9uIGNvbm5lY3Rpb24ocyk6ICR7cHJ1bmVkLmpvaW4oJywgJyl9YClcbiAgfVxufVxuXG5mdW5jdGlvbiBlbnN1cmVQcnVuZVRpbWVyKCk6IHZvaWQge1xuICBpZiAocHJ1bmVUaW1lcikgcmV0dXJuXG4gIHBydW5lVGltZXIgPSBzZXRJbnRlcnZhbChydW5QcnVuZUN5Y2xlLCAxNV8wMDApXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlckRhZW1vbldlYlNvY2tldChcbiAgYXBwOiBIb25vLFxuICB7XG4gICAgZGV2ZWxvcGVyU3VyZmFjZSA9IGZhbHNlLFxuICAgIGRiLFxuICAgIHNlc3Npb25TZWNyZXQsXG4gIH06IHsgZGV2ZWxvcGVyU3VyZmFjZT86IGJvb2xlYW47IGRiPzogRGI7IHNlc3Npb25TZWNyZXQ/OiBzdHJpbmcgfSA9IHt9LFxuKSB7XG4gIGFwcC5nZXQoXG4gICAgREFFTU9OX1dTX1BBVEgsXG4gICAgdXBncmFkZVdlYlNvY2tldCgoYykgPT4ge1xuICAgICAgY29uc3QgcmVtb3RlQWRkcmVzcyA9IGMucmVxLmhlYWRlcigneC1yZWFsLWlwJyk/LnRyaW0oKSB8fFxuICAgICAgICBjLnJlcS5oZWFkZXIoJ3gtZm9yd2FyZGVkLWZvcicpPy5zcGxpdCgnLCcpWzBdPy50cmltKClcbiAgICAgIGxldCBjb25uSWQ6IHN0cmluZyB8IHVuZGVmaW5lZFxuICAgICAgbGV0IGlkZW50aXR5QWRkcmVzcyA9IHJlbW90ZUFkZHJlc3MgPz8gJ19fZGlyZWN0X18nXG4gICAgICBsZXQgcGluZ1RpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCB1bmRlZmluZWRcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb25PcGVuKF9ldmVudCwgd3MpIHtcbiAgICAgICAgICBlbnN1cmVQcnVuZVRpbWVyKClcbiAgICAgICAgICBjb25zdCBjb25uID0gcmVnaXN0ZXJEYWVtb24oXG4gICAgICAgICAgICAoZGF0YSkgPT4gd3Muc2VuZChkYXRhKSxcbiAgICAgICAgICAgICgpID0+IHdzLmNsb3NlKCksXG4gICAgICAgICAgKVxuICAgICAgICAgIGNvbm5JZCA9IGNvbm4uaWRcbiAgICAgICAgICAvLyBDYWRkeSBzZXRzIFgtUmVhbC1JUCBmb3IgcmVtb3RlIGFnZW50czsgY28tbG9jYXRlZCB1bml4LXNvY2tldCBkYWVtb25zXG4gICAgICAgICAgLy8gaGF2ZSBubyBwcm94eSBob3Ag4oCUIGNvbGxhcHNlIHRob3NlIHVuZGVyIGEgc2luZ2xlIGxvY2FsIHNsb3QuXG4gICAgICAgICAgaWRlbnRpdHlBZGRyZXNzID0gcmVtb3RlQWRkcmVzcyA/PyAnX19kaXJlY3RfXydcbiAgICAgICAgICBzZXREYWVtb25SZW1vdGVBZGRyZXNzKGNvbm4uaWQsIGlkZW50aXR5QWRkcmVzcylcbiAgICAgICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgICAgIGBbd3NdIGRhZW1vbiBjb25uZWN0ZWQ6ICR7Y29ubi5pZH0ke1xuICAgICAgICAgICAgICByZW1vdGVBZGRyZXNzID8gYCBmcm9tICR7cmVtb3RlQWRkcmVzc31gIDogJydcbiAgICAgICAgICAgIH1gLFxuICAgICAgICAgIClcblxuICAgICAgICAgIGNvbnN0IGhlbGxvOiBEYWVtb25NZXNzYWdlID0ge1xuICAgICAgICAgICAgdHlwZTogJ2hlbGxvJyxcbiAgICAgICAgICAgIGZyb206ICdpbnN0YW5jZScsXG4gICAgICAgICAgICBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICAgIH1cbiAgICAgICAgICByZWNvcmREYWVtb25NZXNzYWdlKGNvbm4uaWQsICdvdXQnLCBoZWxsbylcbiAgICAgICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KGhlbGxvKSlcblxuICAgICAgICAgIC8vIE5vIHZlcnNpb24gcHVzaDogdGhlIGRhZW1vbiBuZXZlciBzZWxmLXVwZGF0ZXMuIFVwZGF0ZXMgYXJlXG4gICAgICAgICAgLy8gb3BlcmF0b3ItZHJpdmVuIChhZG1pbiB1cGdyYWRlIGJ1dHRvbiAvIGRldi1zeW5jKS5cblxuICAgICAgICAgIHBpbmdUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHBpbmc6IERhZW1vbk1lc3NhZ2UgPSB7XG4gICAgICAgICAgICAgIHR5cGU6ICdwaW5nJyxcbiAgICAgICAgICAgICAgaWQ6IGNyeXB0by5yYW5kb21VVUlEKCksXG4gICAgICAgICAgICAgIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB3cy5zZW5kKEpTT04uc3RyaW5naWZ5KHBpbmcpKVxuICAgICAgICAgIH0sIDE1XzAwMClcbiAgICAgICAgfSxcblxuICAgICAgICBvbk1lc3NhZ2UoZXZlbnQsIHdzKSB7XG4gICAgICAgICAgY29uc3QgcmF3ID0gdHlwZW9mIGV2ZW50LmRhdGEgPT09ICdzdHJpbmcnXG4gICAgICAgICAgICA/IGV2ZW50LmRhdGFcbiAgICAgICAgICAgIDogU3RyaW5nKGV2ZW50LmRhdGEpXG4gICAgICAgICAgY29uc3QgbWVzc2FnZSA9IHBhcnNlRGFlbW9uTWVzc2FnZShyYXcpXG4gICAgICAgICAgaWYgKCFtZXNzYWdlKSB7XG4gICAgICAgICAgICBjb25zb2xlLndhcm4oJ1t3c10gaWdub3JlZCBub24tSlNPTiBtZXNzYWdlIGZyb20gZGFlbW9uJylcbiAgICAgICAgICAgIHJldHVyblxuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnNvbGUubG9nKGBbd3NdIGZyb20gJHtjb25uSWQgPz8gJ3Vua25vd24nfTpgLCBtZXNzYWdlLnR5cGUpXG4gICAgICAgICAgaWYgKGNvbm5JZCkge1xuICAgICAgICAgICAgdG91Y2hEYWVtb25JbmJvdW5kKGNvbm5JZClcbiAgICAgICAgICAgIHJlY29yZERhZW1vbk1lc3NhZ2UoY29ubklkLCAnaW4nLCBtZXNzYWdlKVxuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdoZWxsbycgJiYgbWVzc2FnZS5mcm9tID09PSAnZGFlbW9uJyAmJiBjb25uSWQpIHtcbiAgICAgICAgICAgIGNvbnN0IHNvY2tldElkID0gY29ubklkXG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgIGlmIChtZXNzYWdlLmhvc3RuYW1lKSBzZXREYWVtb25Ib3N0bmFtZShzb2NrZXRJZCwgbWVzc2FnZS5ob3N0bmFtZSlcblxuICAgICAgICAgICAgICBsZXQgc2VydmVySWQ6IHN0cmluZyB8IHVuZGVmaW5lZFxuICAgICAgICAgICAgICBpZiAoZGIpIHtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgc2VydmVySWQgPSBhd2FpdCByZXNvbHZlU2VydmVySWQoZGIsIHtcbiAgICAgICAgICAgICAgICAgICAgc2VydmVySWQ6IG1lc3NhZ2Uuc2VydmVySWQsXG4gICAgICAgICAgICAgICAgICAgIG1hY2hpbmVJZDogbWVzc2FnZS5tYWNoaW5lSWQsXG4gICAgICAgICAgICAgICAgICAgIGhvc3RuYW1lOiBtZXNzYWdlLmhvc3RuYW1lLFxuICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAgIGNvbm5JZCA9IHNldERhZW1vblNlcnZlcklkKHNvY2tldElkLCBzZXJ2ZXJJZClcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1t3c10gZmFpbGVkIHRvIHJlc29sdmUgc2VydmVyIGlkOicsIGVycilcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS53YXJuKCdbd3NdIG5vIGRhdGFiYXNlIGNvbmZpZ3VyZWQg4oCUIHNlcnZlciBpZCBub3QgYXNzaWduZWQnKVxuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgY29uc3QgYWN0aXZlSWQgPSBjb25uSWQgPz8gc29ja2V0SWRcbiAgICAgICAgICAgICAgY29uc3QgZXZpY3RlZCA9IGV2aWN0RHVwbGljYXRlRGFlbW9ucyhhY3RpdmVJZCwge1xuICAgICAgICAgICAgICAgIGhvc3RuYW1lOiBtZXNzYWdlLmhvc3RuYW1lLFxuICAgICAgICAgICAgICAgIHNlcnZlcklkLFxuICAgICAgICAgICAgICAgIHJlbW90ZUFkZHJlc3M6IGlkZW50aXR5QWRkcmVzcyxcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgaWYgKGV2aWN0ZWQubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICAgICAgICAgICAgYFt3c10gZXZpY3RlZCAke2V2aWN0ZWQubGVuZ3RofSBkdXBsaWNhdGUgY29ubmVjdGlvbihzKSBmb3IgJHtcbiAgICAgICAgICAgICAgICAgICAgc2VydmVySWQgPz8gbWVzc2FnZS5ob3N0bmFtZSA/PyBhY3RpdmVJZFxuICAgICAgICAgICAgICAgICAgfWAsXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgaWYgKHNlcnZlcklkKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgYWNrOiBEYWVtb25NZXNzYWdlID0ge1xuICAgICAgICAgICAgICAgICAgdHlwZTogJ2hlbGxvJyxcbiAgICAgICAgICAgICAgICAgIGZyb206ICdpbnN0YW5jZScsXG4gICAgICAgICAgICAgICAgICBzZXJ2ZXJJZCxcbiAgICAgICAgICAgICAgICAgIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJlY29yZERhZW1vbk1lc3NhZ2UoYWN0aXZlSWQsICdvdXQnLCBhY2spXG4gICAgICAgICAgICAgICAgd3Muc2VuZChKU09OLnN0cmluZ2lmeShhY2spKVxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbd3NdIGRhZW1vbiBzZXJ2ZXIgaWQ6ICR7c2VydmVySWR9ICgke2FjdGl2ZUlkfSlgKVxuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgaWYgKG1lc3NhZ2UuaG9zdG5hbWUpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgW3dzXSBkYWVtb24gaG9zdG5hbWU6ICR7bWVzc2FnZS5ob3N0bmFtZX0gKCR7YWN0aXZlSWR9KWApXG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcHJvYmVEYWVtb25Ib3N0bmFtZShhY3RpdmVJZClcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSkoKVxuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdwaW5nJykge1xuICAgICAgICAgICAgY29uc3QgcG9uZzogRGFlbW9uTWVzc2FnZSA9IHtcbiAgICAgICAgICAgICAgdHlwZTogJ3BvbmcnLFxuICAgICAgICAgICAgICBpZDogbWVzc2FnZS5pZCxcbiAgICAgICAgICAgICAgYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChjb25uSWQpIHJlY29yZERhZW1vbk1lc3NhZ2UoY29ubklkLCAnb3V0JywgcG9uZylcbiAgICAgICAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkocG9uZykpXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ2NvbW1hbmQtcmVzdWx0Jykge1xuICAgICAgICAgICAgcmVjb3JkQ29tbWFuZFJlc3VsdChtZXNzYWdlKVxuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdhZGRyZXNzZXMtcmVzdWx0Jykge1xuICAgICAgICAgICAgcmVjb3JkQWRkcmVzc2VzUmVzdWx0KG1lc3NhZ2UpXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgbWVzc2FnZS50eXBlID09PSAnZGV2LXN5bmMtcmVzdWx0JyB8fFxuICAgICAgICAgICAgbWVzc2FnZS50eXBlID09PSAndHVubmVsLXRva2VuLXJlc3VsdCdcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIHJlY29yZERhZW1vbkFjayhtZXNzYWdlLmlkLCBtZXNzYWdlLm9rLCBtZXNzYWdlLmVycm9yKVxuICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBvbkNsb3NlKCkge1xuICAgICAgICAgIGlmIChwaW5nVGltZXIpIGNsZWFySW50ZXJ2YWwocGluZ1RpbWVyKVxuICAgICAgICAgIGlmIChjb25uSWQpIHtcbiAgICAgICAgICAgIHVucmVnaXN0ZXJEYWVtb24oY29ubklkKVxuICAgICAgICAgICAgY29uc29sZS5sb2coYFt3c10gZGFlbW9uIGRpc2Nvbm5lY3RlZDogJHtjb25uSWR9YClcbiAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgb25FcnJvcihfZXZlbnQpIHtcbiAgICAgICAgICBpZiAocGluZ1RpbWVyKSBjbGVhckludGVydmFsKHBpbmdUaW1lcilcbiAgICAgICAgICBpZiAoY29ubklkKSB1bnJlZ2lzdGVyRGFlbW9uKGNvbm5JZClcbiAgICAgICAgfSxcbiAgICAgIH1cbiAgICB9KSxcbiAgKVxuXG4gIGlmIChkZXZlbG9wZXJTdXJmYWNlKSB7XG4gICAgcmVnaXN0ZXJTdHViV2ViU29ja2V0KGFwcCwgREVWRUxPUEVSX1dTX1BBVEgsICdkZXZlbG9wZXInKVxuXG4gICAgYXBwLmdldChcbiAgICAgIERFVkVMT1BFUl9FWFBPX1BUWV9XU19QQVRILFxuICAgICAgYXN5bmMgKGMsIG5leHQpID0+IHtcbiAgICAgICAgaWYgKCFzZXNzaW9uU2VjcmV0KSB7XG4gICAgICAgICAgcmV0dXJuIGMuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6ICdVbmF1dGhvcml6ZWQnIH0sIDQwMSlcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBzZXNzaW9uID0gYXdhaXQgcmVzb2x2ZVJvb3RTZXNzaW9uKGMsIHNlc3Npb25TZWNyZXQsIGRiKVxuICAgICAgICBpZiAoIXNlc3Npb24pIHtcbiAgICAgICAgICByZXR1cm4gYy5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogJ1VuYXV0aG9yaXplZCcgfSwgNDAxKVxuICAgICAgICB9XG4gICAgICAgIGF3YWl0IG5leHQoKVxuICAgICAgfSxcbiAgICAgIHVwZ3JhZGVXZWJTb2NrZXQoKCkgPT4ge1xuICAgICAgICBsZXQgY2xlYW51cDogKCgpID0+IHZvaWQpIHwgdW5kZWZpbmVkXG4gICAgICAgIGxldCBzdHJlYW1TdGFydGVkID0gZmFsc2VcblxuICAgICAgICBjb25zdCBjbGFtcFNpemUgPSAoY29sczogdW5rbm93biwgcm93czogdW5rbm93bikgPT4gKHtcbiAgICAgICAgICBjb2xzOiBNYXRoLm1heCgyLCBNYXRoLm1pbig1MDAsIE1hdGguZmxvb3IoTnVtYmVyKGNvbHMpKSkpLFxuICAgICAgICAgIHJvd3M6IE1hdGgubWF4KDEsIE1hdGgubWluKDIwMCwgTWF0aC5mbG9vcihOdW1iZXIocm93cykpKSksXG4gICAgICAgIH0pXG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvbk9wZW4oX2V2ZW50LCBfd3MpIHtcbiAgICAgICAgICAgIC8vIFdhaXQgZm9yIGNsaWVudCBsb2ctcGFuZWwgZGltZW5zaW9ucyBiZWZvcmUgc3RyZWFtaW5nLlxuICAgICAgICAgIH0sXG5cbiAgICAgICAgICBvbk1lc3NhZ2UoZXZlbnQsIHdzKSB7XG4gICAgICAgICAgICBjb25zdCByYXcgPSB0eXBlb2YgZXZlbnQuZGF0YSA9PT0gJ3N0cmluZycgPyBldmVudC5kYXRhIDogU3RyaW5nKGV2ZW50LmRhdGEpXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMge1xuICAgICAgICAgICAgICAgIHR5cGU/OiBzdHJpbmdcbiAgICAgICAgICAgICAgICBkYXRhPzogc3RyaW5nXG4gICAgICAgICAgICAgICAgY29scz86IG51bWJlclxuICAgICAgICAgICAgICAgIHJvd3M/OiBudW1iZXJcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAocGFyc2VkLnR5cGUgPT09ICdyZXNpemUnKSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgc2l6ZSA9IGNsYW1wU2l6ZShwYXJzZWQuY29scywgcGFyc2VkLnJvd3MpXG4gICAgICAgICAgICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoc2l6ZS5jb2xzKSB8fCAhTnVtYmVyLmlzRmluaXRlKHNpemUucm93cykpIHJldHVyblxuICAgICAgICAgICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICAgIGF3YWl0IHJlc2l6ZUV4cG9UbXV4UGFuZShzaXplLmNvbHMsIHNpemUucm93cylcbiAgICAgICAgICAgICAgICAgIGlmICghc3RyZWFtU3RhcnRlZCkge1xuICAgICAgICAgICAgICAgICAgICBzdHJlYW1TdGFydGVkID0gdHJ1ZVxuICAgICAgICAgICAgICAgICAgICBjbGVhbnVwID0gc3RyZWFtRXhwb1RtdXhQdHkoXG4gICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgc2VuZDogKGRhdGEpID0+IHdzLnNlbmQoZGF0YSksXG4gICAgICAgICAgICAgICAgICAgICAgICBjbG9zZTogKCkgPT4gd3MuY2xvc2UoKSxcbiAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgIHNpemUsXG4gICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KSgpXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgaWYgKHBhcnNlZC50eXBlID09PSAnaW5wdXQnICYmIHR5cGVvZiBwYXJzZWQuZGF0YSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICB2b2lkIHNlbmRFeHBvS2V5cyhwYXJzZWQuZGF0YSlcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgIC8vIGlnbm9yZSBtYWxmb3JtZWQgZnJhbWVzXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSxcblxuICAgICAgICAgIG9uQ2xvc2UoKSB7XG4gICAgICAgICAgICBjbGVhbnVwPy4oKVxuICAgICAgICAgIH0sXG5cbiAgICAgICAgICBvbkVycm9yKCkge1xuICAgICAgICAgICAgY2xlYW51cD8uKClcbiAgICAgICAgICB9LFxuICAgICAgICB9XG4gICAgICB9KSxcbiAgICApXG4gIH1cbiAgcmVnaXN0ZXJTdHViV2ViU29ja2V0KGFwcCwgQ0xJRU5UX1dTX1BBVEgsICdjbGllbnQnKVxufVxuXG4vKipcbiAqIFBsYWNlaG9sZGVyIFdlYlNvY2tldCBzdXJmYWNlIGZvciB0aGUgYWRtaW4vY2xpZW50IFVJcy4gVG9kYXkgdGhlIFVJcyBwb2xsXG4gKiBSRVNUOyB0aGVzZSBlbmRwb2ludHMgcmVzZXJ2ZSB0aGUgbmFtZXNwYWNlIGZvciBmdXR1cmUgbGl2ZSBzdHJlYW1pbmcuIFRoZXlcbiAqIGFjY2VwdCB0aGUgdXBncmFkZSwgZ3JlZXQgdGhlIHBlZXIsIGFuZCBvdGhlcndpc2UgaWRsZS5cbiAqL1xuZnVuY3Rpb24gcmVnaXN0ZXJTdHViV2ViU29ja2V0KGFwcDogSG9ubywgcGF0aDogc3RyaW5nLCBzdXJmYWNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgYXBwLmdldChcbiAgICBwYXRoLFxuICAgIHVwZ3JhZGVXZWJTb2NrZXQoKCkgPT4gKHtcbiAgICAgIG9uT3BlbihfZXZlbnQsIHdzKSB7XG4gICAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIHR5cGU6ICdoZWxsbycsXG4gICAgICAgICAgc3VyZmFjZSxcbiAgICAgICAgICBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICB9KSlcbiAgICAgIH0sXG4gICAgfSkpLFxuICApXG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQ0EsU0FBUyxnQkFBZ0IsUUFBUSxZQUFXO0FBQzVDLFNBQVMsa0JBQWtCLFFBQVEsdUJBQXNCO0FBQ3pELFNBRUUscUJBQXFCLEVBQ3JCLGtCQUFrQixFQUNsQixpQkFBaUIsRUFDakIscUJBQXFCLEVBQ3JCLG1CQUFtQixFQUNuQixlQUFlLEVBQ2YsbUJBQW1CLEVBQ25CLGNBQWMsRUFDZCxpQkFBaUIsRUFDakIsaUJBQWlCLEVBQ2pCLG1CQUFtQixFQUNuQixxQkFBcUIsRUFDckIsc0JBQXNCLEVBQ3RCLGtCQUFrQixFQUNsQixnQkFBZ0IsUUFDWCxrQkFBaUI7QUFFeEIsU0FBUyxlQUFlLFFBQVEsdUJBQXNCO0FBRXRELFNBQVMsa0JBQWtCLEVBQUUsWUFBWSxFQUFFLGlCQUFpQixRQUFRLGdCQUFlO0FBQ25GLFNBQ0UsY0FBYyxFQUNkLGNBQWMsRUFDZCwwQkFBMEIsRUFDMUIsaUJBQWlCLFFBQ1osZ0JBQWU7QUFFdEIsSUFBSTtBQUVKLFNBQVM7RUFDUDtFQUNBLE1BQU0sU0FBUztFQUNmLElBQUksT0FBTyxNQUFNLEdBQUcsR0FBRztJQUNyQixRQUFRLEdBQUcsQ0FBQyxDQUFDLFlBQVksRUFBRSxPQUFPLE1BQU0sQ0FBQyw2QkFBNkIsRUFBRSxPQUFPLElBQUksQ0FBQyxPQUFPO0VBQzdGO0FBQ0Y7QUFFQSxTQUFTO0VBQ1AsSUFBSSxZQUFZO0VBQ2hCLGFBQWEsWUFBWSxlQUFlO0FBQzFDO0FBRUEsT0FBTyxTQUFTLHdCQUNkLEdBQVMsRUFDVCxFQUNFLG1CQUFtQixLQUFLLEVBQ3hCLEVBQUUsRUFDRixhQUFhLEVBQ21ELEdBQUcsQ0FBQyxDQUFDO0VBRXZFLElBQUksR0FBRyxDQUNMLGdCQUNBLGlCQUFpQixDQUFDO0lBQ2hCLE1BQU0sZ0JBQWdCLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxjQUFjLFVBQy9DLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxvQkFBb0IsTUFBTSxJQUFJLENBQUMsRUFBRSxFQUFFO0lBQ2xELElBQUk7SUFDSixJQUFJLGtCQUFrQixpQkFBaUI7SUFDdkMsSUFBSTtJQUVKLE9BQU87TUFDTCxRQUFPLE1BQU0sRUFBRSxFQUFFO1FBQ2Y7UUFDQSxNQUFNLE9BQU8sZUFDWCxDQUFDLE9BQVMsR0FBRyxJQUFJLENBQUMsT0FDbEIsSUFBTSxHQUFHLEtBQUs7UUFFaEIsU0FBUyxLQUFLLEVBQUU7UUFDaEIseUVBQXlFO1FBQ3pFLGdFQUFnRTtRQUNoRSxrQkFBa0IsaUJBQWlCO1FBQ25DLHVCQUF1QixLQUFLLEVBQUUsRUFBRTtRQUNoQyxRQUFRLEdBQUcsQ0FDVCxDQUFDLHVCQUF1QixFQUFFLEtBQUssRUFBRSxHQUMvQixnQkFBZ0IsQ0FBQyxNQUFNLEVBQUUsZUFBZSxHQUFHLElBQzNDO1FBR0osTUFBTSxRQUF1QjtVQUMzQixNQUFNO1VBQ04sTUFBTTtVQUNOLElBQUksSUFBSSxPQUFPLFdBQVc7UUFDNUI7UUFDQSxvQkFBb0IsS0FBSyxFQUFFLEVBQUUsT0FBTztRQUNwQyxHQUFHLElBQUksQ0FBQyxLQUFLLFNBQVMsQ0FBQztRQUV2Qiw4REFBOEQ7UUFDOUQscURBQXFEO1FBRXJELFlBQVksWUFBWTtVQUN0QixNQUFNLE9BQXNCO1lBQzFCLE1BQU07WUFDTixJQUFJLE9BQU8sVUFBVTtZQUNyQixJQUFJLElBQUksT0FBTyxXQUFXO1VBQzVCO1VBQ0EsR0FBRyxJQUFJLENBQUMsS0FBSyxTQUFTLENBQUM7UUFDekIsR0FBRztNQUNMO01BRUEsV0FBVSxLQUFLLEVBQUUsRUFBRTtRQUNqQixNQUFNLE1BQU0sT0FBTyxNQUFNLElBQUksS0FBSyxXQUM5QixNQUFNLElBQUksR0FDVixPQUFPLE1BQU0sSUFBSTtRQUNyQixNQUFNLFVBQVUsbUJBQW1CO1FBQ25DLElBQUksQ0FBQyxTQUFTO1VBQ1osUUFBUSxJQUFJLENBQUM7VUFDYjtRQUNGO1FBRUEsUUFBUSxHQUFHLENBQUMsQ0FBQyxVQUFVLEVBQUUsVUFBVSxVQUFVLENBQUMsQ0FBQyxFQUFFLFFBQVEsSUFBSTtRQUM3RCxJQUFJLFFBQVE7VUFDVixtQkFBbUI7VUFDbkIsb0JBQW9CLFFBQVEsTUFBTTtRQUNwQztRQUVBLElBQUksUUFBUSxJQUFJLEtBQUssV0FBVyxRQUFRLElBQUksS0FBSyxZQUFZLFFBQVE7VUFDbkUsTUFBTSxXQUFXO1VBQ2pCLEtBQUssQ0FBQztZQUNKLElBQUksUUFBUSxRQUFRLEVBQUUsa0JBQWtCLFVBQVUsUUFBUSxRQUFRO1lBRWxFLElBQUk7WUFDSixJQUFJLElBQUk7Y0FDTixJQUFJO2dCQUNGLFdBQVcsTUFBTSxnQkFBZ0IsSUFBSTtrQkFDbkMsVUFBVSxRQUFRLFFBQVE7a0JBQzFCLFdBQVcsUUFBUSxTQUFTO2tCQUM1QixVQUFVLFFBQVEsUUFBUTtnQkFDNUI7Z0JBQ0EsU0FBUyxrQkFBa0IsVUFBVTtjQUN2QyxFQUFFLE9BQU8sS0FBSztnQkFDWixRQUFRLEtBQUssQ0FBQyxxQ0FBcUM7Y0FDckQ7WUFDRixPQUFPO2NBQ0wsUUFBUSxJQUFJLENBQUM7WUFDZjtZQUVBLE1BQU0sV0FBVyxVQUFVO1lBQzNCLE1BQU0sVUFBVSxzQkFBc0IsVUFBVTtjQUM5QyxVQUFVLFFBQVEsUUFBUTtjQUMxQjtjQUNBLGVBQWU7WUFDakI7WUFDQSxJQUFJLFFBQVEsTUFBTSxHQUFHLEdBQUc7Y0FDdEIsUUFBUSxHQUFHLENBQ1QsQ0FBQyxhQUFhLEVBQUUsUUFBUSxNQUFNLENBQUMsNkJBQTZCLEVBQzFELFlBQVksUUFBUSxRQUFRLElBQUksVUFDaEM7WUFFTjtZQUVBLElBQUksVUFBVTtjQUNaLE1BQU0sTUFBcUI7Z0JBQ3pCLE1BQU07Z0JBQ04sTUFBTTtnQkFDTjtnQkFDQSxJQUFJLElBQUksT0FBTyxXQUFXO2NBQzVCO2NBQ0Esb0JBQW9CLFVBQVUsT0FBTztjQUNyQyxHQUFHLElBQUksQ0FBQyxLQUFLLFNBQVMsQ0FBQztjQUN2QixRQUFRLEdBQUcsQ0FBQyxDQUFDLHVCQUF1QixFQUFFLFNBQVMsRUFBRSxFQUFFLFNBQVMsQ0FBQyxDQUFDO1lBQ2hFO1lBRUEsSUFBSSxRQUFRLFFBQVEsRUFBRTtjQUNwQixRQUFRLEdBQUcsQ0FBQyxDQUFDLHNCQUFzQixFQUFFLFFBQVEsUUFBUSxDQUFDLEVBQUUsRUFBRSxTQUFTLENBQUMsQ0FBQztZQUN2RSxPQUFPO2NBQ0wsb0JBQW9CO1lBQ3RCO1VBQ0YsQ0FBQztRQUNIO1FBRUEsSUFBSSxRQUFRLElBQUksS0FBSyxRQUFRO1VBQzNCLE1BQU0sT0FBc0I7WUFDMUIsTUFBTTtZQUNOLElBQUksUUFBUSxFQUFFO1lBQ2QsSUFBSSxJQUFJLE9BQU8sV0FBVztVQUM1QjtVQUNBLElBQUksUUFBUSxvQkFBb0IsUUFBUSxPQUFPO1VBQy9DLEdBQUcsSUFBSSxDQUFDLEtBQUssU0FBUyxDQUFDO1FBQ3pCO1FBRUEsSUFBSSxRQUFRLElBQUksS0FBSyxrQkFBa0I7VUFDckMsb0JBQW9CO1FBQ3RCO1FBRUEsSUFBSSxRQUFRLElBQUksS0FBSyxvQkFBb0I7VUFDdkMsc0JBQXNCO1FBQ3hCO1FBRUEsSUFDRSxRQUFRLElBQUksS0FBSyxxQkFDakIsUUFBUSxJQUFJLEtBQUssdUJBQ2pCO1VBQ0EsZ0JBQWdCLFFBQVEsRUFBRSxFQUFFLFFBQVEsRUFBRSxFQUFFLFFBQVEsS0FBSztRQUN2RDtNQUNGO01BRUE7UUFDRSxJQUFJLFdBQVcsY0FBYztRQUM3QixJQUFJLFFBQVE7VUFDVixpQkFBaUI7VUFDakIsUUFBUSxHQUFHLENBQUMsQ0FBQywwQkFBMEIsRUFBRSxRQUFRO1FBQ25EO01BQ0Y7TUFFQSxTQUFRLE1BQU07UUFDWixJQUFJLFdBQVcsY0FBYztRQUM3QixJQUFJLFFBQVEsaUJBQWlCO01BQy9CO0lBQ0Y7RUFDRjtFQUdGLElBQUksa0JBQWtCO0lBQ3BCLHNCQUFzQixLQUFLLG1CQUFtQjtJQUU5QyxJQUFJLEdBQUcsQ0FDTCw0QkFDQSxPQUFPLEdBQUc7TUFDUixJQUFJLENBQUMsZUFBZTtRQUNsQixPQUFPLEVBQUUsSUFBSSxDQUFDO1VBQUUsSUFBSTtVQUFPLE9BQU87UUFBZSxHQUFHO01BQ3REO01BQ0EsTUFBTSxVQUFVLE1BQU0sbUJBQW1CLEdBQUcsZUFBZTtNQUMzRCxJQUFJLENBQUMsU0FBUztRQUNaLE9BQU8sRUFBRSxJQUFJLENBQUM7VUFBRSxJQUFJO1VBQU8sT0FBTztRQUFlLEdBQUc7TUFDdEQ7TUFDQSxNQUFNO0lBQ1IsR0FDQSxpQkFBaUI7TUFDZixJQUFJO01BQ0osSUFBSSxnQkFBZ0I7TUFFcEIsTUFBTSxZQUFZLENBQUMsTUFBZSxPQUFrQixDQUFDO1VBQ25ELE1BQU0sS0FBSyxHQUFHLENBQUMsR0FBRyxLQUFLLEdBQUcsQ0FBQyxLQUFLLEtBQUssS0FBSyxDQUFDLE9BQU87VUFDbEQsTUFBTSxLQUFLLEdBQUcsQ0FBQyxHQUFHLEtBQUssR0FBRyxDQUFDLEtBQUssS0FBSyxLQUFLLENBQUMsT0FBTztRQUNwRCxDQUFDO01BRUQsT0FBTztRQUNMLFFBQU8sTUFBTSxFQUFFLEdBQUc7UUFDaEIseURBQXlEO1FBQzNEO1FBRUEsV0FBVSxLQUFLLEVBQUUsRUFBRTtVQUNqQixNQUFNLE1BQU0sT0FBTyxNQUFNLElBQUksS0FBSyxXQUFXLE1BQU0sSUFBSSxHQUFHLE9BQU8sTUFBTSxJQUFJO1VBQzNFLElBQUk7WUFDRixNQUFNLFNBQVMsS0FBSyxLQUFLLENBQUM7WUFNMUIsSUFBSSxPQUFPLElBQUksS0FBSyxVQUFVO2NBQzVCLE1BQU0sT0FBTyxVQUFVLE9BQU8sSUFBSSxFQUFFLE9BQU8sSUFBSTtjQUMvQyxJQUFJLENBQUMsT0FBTyxRQUFRLENBQUMsS0FBSyxJQUFJLEtBQUssQ0FBQyxPQUFPLFFBQVEsQ0FBQyxLQUFLLElBQUksR0FBRztjQUNoRSxLQUFLLENBQUM7Z0JBQ0osTUFBTSxtQkFBbUIsS0FBSyxJQUFJLEVBQUUsS0FBSyxJQUFJO2dCQUM3QyxJQUFJLENBQUMsZUFBZTtrQkFDbEIsZ0JBQWdCO2tCQUNoQixVQUFVLGtCQUNSO29CQUNFLE1BQU0sQ0FBQyxPQUFTLEdBQUcsSUFBSSxDQUFDO29CQUN4QixPQUFPLElBQU0sR0FBRyxLQUFLO2tCQUN2QixHQUNBO2dCQUVKO2NBQ0YsQ0FBQztZQUNIO1lBQ0EsSUFBSSxPQUFPLElBQUksS0FBSyxXQUFXLE9BQU8sT0FBTyxJQUFJLEtBQUssVUFBVTtjQUM5RCxLQUFLLGFBQWEsT0FBTyxJQUFJO1lBQy9CO1VBQ0YsRUFBRSxPQUFNO1VBQ04sMEJBQTBCO1VBQzVCO1FBQ0Y7UUFFQTtVQUNFO1FBQ0Y7UUFFQTtVQUNFO1FBQ0Y7TUFDRjtJQUNGO0VBRUo7RUFDQSxzQkFBc0IsS0FBSyxnQkFBZ0I7QUFDN0M7QUFFQTs7OztDQUlDLEdBQ0QsU0FBUyxzQkFBc0IsR0FBUyxFQUFFLElBQVksRUFBRSxPQUFlO0VBQ3JFLElBQUksR0FBRyxDQUNMLE1BQ0EsaUJBQWlCLElBQU0sQ0FBQztNQUN0QixRQUFPLE1BQU0sRUFBRSxFQUFFO1FBQ2YsR0FBRyxJQUFJLENBQUMsS0FBSyxTQUFTLENBQUM7VUFDckIsTUFBTTtVQUNOO1VBQ0EsSUFBSSxJQUFJLE9BQU8sV0FBVztRQUM1QjtNQUNGO0lBQ0YsQ0FBQztBQUVMIn0=
// denoCacheMetadata=10962880005268218113,13033650943848258022