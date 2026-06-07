import { encodeBase64 } from 'jsr:@std/encoding@1/base64';
import { awaitDaemonAck, listDaemonConnections, sendToDaemon } from './daemon-hub.ts';
import { getDaemonRepoPath } from './daemon-version.ts';
import { DEVELOPER_API_PREFIX } from './surfaces.ts';
/** Base64 characters per chunk (~256 KiB of payload before encoding). */ const CHUNK_CHARS = 256 * 1024;
/** Generous ceiling: tar + transfer + unpack + deno cache + restart ack. */ const DEV_SYNC_TIMEOUT_MS = 180_000;
/**
 * Build a gzipped tarball of the local daemon checkout, excluding heavy,
 * host-specific, or generated paths. Requires `--allow-run=tar`.
 */ async function buildDaemonTarball(repo) {
  const tmp = await Deno.makeTempFile({
    suffix: '.tgz'
  });
  try {
    const command = new Deno.Command('tar', {
      args: [
        '-czf',
        tmp,
        '-C',
        repo,
        '--exclude=./.git',
        '--exclude=./orchestration/runtime',
        '--exclude=./orchestration/roles',
        '--exclude=./cloudflared/tunnels',
        '--exclude=./node_modules',
        '.'
      ],
      stdout: 'piped',
      stderr: 'piped'
    });
    const out = await command.output();
    if (!out.success) {
      throw new Error(`tar failed: ${new TextDecoder().decode(out.stderr).trim()}`);
    }
    return await Deno.readFile(tmp);
  } finally{
    await Deno.remove(tmp).catch(()=>{});
  }
}
/**
 * Package the instance host's current daemon build and stream it to one
 * connected daemon over the WebSocket, then wait for it to unpack + restart.
 */ export async function syncDevToDaemon(daemonId) {
  const tarball = await buildDaemonTarball(getDaemonRepoPath());
  const base64 = encodeBase64(tarball);
  const id = crypto.randomUUID();
  const totalChunks = Math.max(1, Math.ceil(base64.length / CHUNK_CHARS));
  const begin = {
    type: 'dev-sync-begin',
    id,
    totalChunks,
    totalBytes: tarball.byteLength,
    at: new Date().toISOString()
  };
  if (!sendToDaemon(daemonId, begin)) {
    throw new Error('daemon not connected');
  }
  const ack = awaitDaemonAck(id, DEV_SYNC_TIMEOUT_MS);
  for(let i = 0; i < totalChunks; i++){
    const data = base64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
    sendToDaemon(daemonId, {
      type: 'dev-sync-chunk',
      id,
      index: i,
      data,
      at: new Date().toISOString()
    });
  }
  sendToDaemon(daemonId, {
    type: 'dev-sync-end',
    id,
    at: new Date().toISOString()
  });
  await ack;
}
/**
 * Admin routes to push the current dev daemon build to agents. Deno-only: tar +
 * filesystem access are not available in the Workers build.
 */ export function registerDevSyncRoutes(app) {
  app.post(`${DEVELOPER_API_PREFIX}/daemon/:id/sync-dev`, async (c)=>{
    const id = c.req.param('id');
    try {
      await syncDevToDaemon(id);
      return c.json({
        ok: true,
        daemonId: id
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'daemon not connected' ? 404 : 500;
      return c.json({
        ok: false,
        error: message
      }, status);
    }
  });
  app.post(`${DEVELOPER_API_PREFIX}/daemon/sync-dev`, async (c)=>{
    const results = await Promise.all(listDaemonConnections().map(async (conn)=>{
      try {
        await syncDevToDaemon(conn.id);
        return {
          daemonId: conn.id,
          ok: true
        };
      } catch (err) {
        return {
          daemonId: conn.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }));
    return c.json({
      ok: results.every((r)=>r.ok),
      results
    });
  });
  return app;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vb3B0L3R1cmJvcGFuZWwvcGxhdGZvcm0vdHVyYm9wYW5lbC9zcmMvZGV2LXN5bmMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBIb25vIH0gZnJvbSAnaG9ubydcbmltcG9ydCB7IGVuY29kZUJhc2U2NCB9IGZyb20gJ2pzcjpAc3RkL2VuY29kaW5nQDEvYmFzZTY0J1xuaW1wb3J0IHtcbiAgYXdhaXREYWVtb25BY2ssXG4gIHR5cGUgRGFlbW9uTWVzc2FnZSxcbiAgbGlzdERhZW1vbkNvbm5lY3Rpb25zLFxuICBzZW5kVG9EYWVtb24sXG59IGZyb20gJy4vZGFlbW9uLWh1Yi50cydcbmltcG9ydCB7IGdldERhZW1vblJlcG9QYXRoIH0gZnJvbSAnLi9kYWVtb24tdmVyc2lvbi50cydcbmltcG9ydCB7IERFVkVMT1BFUl9BUElfUFJFRklYIH0gZnJvbSAnLi9zdXJmYWNlcy50cydcblxuLyoqIEJhc2U2NCBjaGFyYWN0ZXJzIHBlciBjaHVuayAofjI1NiBLaUIgb2YgcGF5bG9hZCBiZWZvcmUgZW5jb2RpbmcpLiAqL1xuY29uc3QgQ0hVTktfQ0hBUlMgPSAyNTYgKiAxMDI0XG4vKiogR2VuZXJvdXMgY2VpbGluZzogdGFyICsgdHJhbnNmZXIgKyB1bnBhY2sgKyBkZW5vIGNhY2hlICsgcmVzdGFydCBhY2suICovXG5jb25zdCBERVZfU1lOQ19USU1FT1VUX01TID0gMTgwXzAwMFxuXG4vKipcbiAqIEJ1aWxkIGEgZ3ppcHBlZCB0YXJiYWxsIG9mIHRoZSBsb2NhbCBkYWVtb24gY2hlY2tvdXQsIGV4Y2x1ZGluZyBoZWF2eSxcbiAqIGhvc3Qtc3BlY2lmaWMsIG9yIGdlbmVyYXRlZCBwYXRocy4gUmVxdWlyZXMgYC0tYWxsb3ctcnVuPXRhcmAuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGJ1aWxkRGFlbW9uVGFyYmFsbChyZXBvOiBzdHJpbmcpOiBQcm9taXNlPFVpbnQ4QXJyYXk+IHtcbiAgY29uc3QgdG1wID0gYXdhaXQgRGVuby5tYWtlVGVtcEZpbGUoeyBzdWZmaXg6ICcudGd6JyB9KVxuICB0cnkge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgRGVuby5Db21tYW5kKCd0YXInLCB7XG4gICAgICBhcmdzOiBbXG4gICAgICAgICctY3pmJyxcbiAgICAgICAgdG1wLFxuICAgICAgICAnLUMnLFxuICAgICAgICByZXBvLFxuICAgICAgICAnLS1leGNsdWRlPS4vLmdpdCcsXG4gICAgICAgICctLWV4Y2x1ZGU9Li9vcmNoZXN0cmF0aW9uL3J1bnRpbWUnLFxuICAgICAgICAnLS1leGNsdWRlPS4vb3JjaGVzdHJhdGlvbi9yb2xlcycsXG4gICAgICAgICctLWV4Y2x1ZGU9Li9jbG91ZGZsYXJlZC90dW5uZWxzJyxcbiAgICAgICAgJy0tZXhjbHVkZT0uL25vZGVfbW9kdWxlcycsXG4gICAgICAgICcuJyxcbiAgICAgIF0sXG4gICAgICBzdGRvdXQ6ICdwaXBlZCcsXG4gICAgICBzdGRlcnI6ICdwaXBlZCcsXG4gICAgfSlcbiAgICBjb25zdCBvdXQgPSBhd2FpdCBjb21tYW5kLm91dHB1dCgpXG4gICAgaWYgKCFvdXQuc3VjY2Vzcykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGB0YXIgZmFpbGVkOiAke25ldyBUZXh0RGVjb2RlcigpLmRlY29kZShvdXQuc3RkZXJyKS50cmltKCl9YClcbiAgICB9XG4gICAgcmV0dXJuIGF3YWl0IERlbm8ucmVhZEZpbGUodG1wKVxuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHRtcCkuY2F0Y2goKCkgPT4ge30pXG4gIH1cbn1cblxuLyoqXG4gKiBQYWNrYWdlIHRoZSBpbnN0YW5jZSBob3N0J3MgY3VycmVudCBkYWVtb24gYnVpbGQgYW5kIHN0cmVhbSBpdCB0byBvbmVcbiAqIGNvbm5lY3RlZCBkYWVtb24gb3ZlciB0aGUgV2ViU29ja2V0LCB0aGVuIHdhaXQgZm9yIGl0IHRvIHVucGFjayArIHJlc3RhcnQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzeW5jRGV2VG9EYWVtb24oZGFlbW9uSWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0YXJiYWxsID0gYXdhaXQgYnVpbGREYWVtb25UYXJiYWxsKGdldERhZW1vblJlcG9QYXRoKCkpXG4gIGNvbnN0IGJhc2U2NCA9IGVuY29kZUJhc2U2NCh0YXJiYWxsKVxuICBjb25zdCBpZCA9IGNyeXB0by5yYW5kb21VVUlEKClcbiAgY29uc3QgdG90YWxDaHVua3MgPSBNYXRoLm1heCgxLCBNYXRoLmNlaWwoYmFzZTY0Lmxlbmd0aCAvIENIVU5LX0NIQVJTKSlcblxuICBjb25zdCBiZWdpbjogRGFlbW9uTWVzc2FnZSA9IHtcbiAgICB0eXBlOiAnZGV2LXN5bmMtYmVnaW4nLFxuICAgIGlkLFxuICAgIHRvdGFsQ2h1bmtzLFxuICAgIHRvdGFsQnl0ZXM6IHRhcmJhbGwuYnl0ZUxlbmd0aCxcbiAgICBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICB9XG4gIGlmICghc2VuZFRvRGFlbW9uKGRhZW1vbklkLCBiZWdpbikpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ2RhZW1vbiBub3QgY29ubmVjdGVkJylcbiAgfVxuXG4gIGNvbnN0IGFjayA9IGF3YWl0RGFlbW9uQWNrKGlkLCBERVZfU1lOQ19USU1FT1VUX01TKVxuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgdG90YWxDaHVua3M7IGkrKykge1xuICAgIGNvbnN0IGRhdGEgPSBiYXNlNjQuc2xpY2UoaSAqIENIVU5LX0NIQVJTLCAoaSArIDEpICogQ0hVTktfQ0hBUlMpXG4gICAgc2VuZFRvRGFlbW9uKGRhZW1vbklkLCB7XG4gICAgICB0eXBlOiAnZGV2LXN5bmMtY2h1bmsnLFxuICAgICAgaWQsXG4gICAgICBpbmRleDogaSxcbiAgICAgIGRhdGEsXG4gICAgICBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIH0pXG4gIH1cblxuICBzZW5kVG9EYWVtb24oZGFlbW9uSWQsIHsgdHlwZTogJ2Rldi1zeW5jLWVuZCcsIGlkLCBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH0pXG5cbiAgYXdhaXQgYWNrXG59XG5cbi8qKlxuICogQWRtaW4gcm91dGVzIHRvIHB1c2ggdGhlIGN1cnJlbnQgZGV2IGRhZW1vbiBidWlsZCB0byBhZ2VudHMuIERlbm8tb25seTogdGFyICtcbiAqIGZpbGVzeXN0ZW0gYWNjZXNzIGFyZSBub3QgYXZhaWxhYmxlIGluIHRoZSBXb3JrZXJzIGJ1aWxkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJEZXZTeW5jUm91dGVzKGFwcDogSG9ubyk6IEhvbm8ge1xuICBhcHAucG9zdChgJHtERVZFTE9QRVJfQVBJX1BSRUZJWH0vZGFlbW9uLzppZC9zeW5jLWRldmAsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgaWQgPSBjLnJlcS5wYXJhbSgnaWQnKVxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBzeW5jRGV2VG9EYWVtb24oaWQpXG4gICAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIGRhZW1vbklkOiBpZCB9KVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgY29uc3Qgc3RhdHVzID0gbWVzc2FnZSA9PT0gJ2RhZW1vbiBub3QgY29ubmVjdGVkJyA/IDQwNCA6IDUwMFxuICAgICAgcmV0dXJuIGMuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IG1lc3NhZ2UgfSwgc3RhdHVzKVxuICAgIH1cbiAgfSlcblxuICBhcHAucG9zdChgJHtERVZFTE9QRVJfQVBJX1BSRUZJWH0vZGFlbW9uL3N5bmMtZGV2YCwgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCByZXN1bHRzID0gYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICBsaXN0RGFlbW9uQ29ubmVjdGlvbnMoKS5tYXAoYXN5bmMgKGNvbm4pID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBhd2FpdCBzeW5jRGV2VG9EYWVtb24oY29ubi5pZClcbiAgICAgICAgICByZXR1cm4geyBkYWVtb25JZDogY29ubi5pZCwgb2s6IHRydWUgfVxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgZGFlbW9uSWQ6IGNvbm4uaWQsXG4gICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSksXG4gICAgKVxuICAgIHJldHVybiBjLmpzb24oeyBvazogcmVzdWx0cy5ldmVyeSgocikgPT4gci5vayksIHJlc3VsdHMgfSlcbiAgfSlcblxuICByZXR1cm4gYXBwXG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQ0EsU0FBUyxZQUFZLFFBQVEsNkJBQTRCO0FBQ3pELFNBQ0UsY0FBYyxFQUVkLHFCQUFxQixFQUNyQixZQUFZLFFBQ1Asa0JBQWlCO0FBQ3hCLFNBQVMsaUJBQWlCLFFBQVEsc0JBQXFCO0FBQ3ZELFNBQVMsb0JBQW9CLFFBQVEsZ0JBQWU7QUFFcEQsdUVBQXVFLEdBQ3ZFLE1BQU0sY0FBYyxNQUFNO0FBQzFCLDBFQUEwRSxHQUMxRSxNQUFNLHNCQUFzQjtBQUU1Qjs7O0NBR0MsR0FDRCxlQUFlLG1CQUFtQixJQUFZO0VBQzVDLE1BQU0sTUFBTSxNQUFNLEtBQUssWUFBWSxDQUFDO0lBQUUsUUFBUTtFQUFPO0VBQ3JELElBQUk7SUFDRixNQUFNLFVBQVUsSUFBSSxLQUFLLE9BQU8sQ0FBQyxPQUFPO01BQ3RDLE1BQU07UUFDSjtRQUNBO1FBQ0E7UUFDQTtRQUNBO1FBQ0E7UUFDQTtRQUNBO1FBQ0E7UUFDQTtPQUNEO01BQ0QsUUFBUTtNQUNSLFFBQVE7SUFDVjtJQUNBLE1BQU0sTUFBTSxNQUFNLFFBQVEsTUFBTTtJQUNoQyxJQUFJLENBQUMsSUFBSSxPQUFPLEVBQUU7TUFD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
// denoCacheMetadata=8749780102868726656,14897841567622947239