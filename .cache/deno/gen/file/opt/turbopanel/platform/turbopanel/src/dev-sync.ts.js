import { createRootOnlyMiddleware } from './auth/middleware.ts';
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
 */ export function registerDevSyncRoutes(app, opts) {
  app.use(`${DEVELOPER_API_PREFIX}/daemon/sync-dev`, createRootOnlyMiddleware(opts.sessionSecret));
  app.use(`${DEVELOPER_API_PREFIX}/daemon/:id/sync-dev`, createRootOnlyMiddleware(opts.sessionSecret));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vb3B0L3R1cmJvcGFuZWwvcGxhdGZvcm0vdHVyYm9wYW5lbC9zcmMvZGV2LXN5bmMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBIb25vIH0gZnJvbSAnaG9ubydcbmltcG9ydCB7IGNyZWF0ZVJvb3RPbmx5TWlkZGxld2FyZSB9IGZyb20gJy4vYXV0aC9taWRkbGV3YXJlLnRzJ1xuaW1wb3J0IHsgZW5jb2RlQmFzZTY0IH0gZnJvbSAnanNyOkBzdGQvZW5jb2RpbmdAMS9iYXNlNjQnXG5pbXBvcnQge1xuICBhd2FpdERhZW1vbkFjayxcbiAgdHlwZSBEYWVtb25NZXNzYWdlLFxuICBsaXN0RGFlbW9uQ29ubmVjdGlvbnMsXG4gIHNlbmRUb0RhZW1vbixcbn0gZnJvbSAnLi9kYWVtb24taHViLnRzJ1xuaW1wb3J0IHsgZ2V0RGFlbW9uUmVwb1BhdGggfSBmcm9tICcuL2RhZW1vbi12ZXJzaW9uLnRzJ1xuaW1wb3J0IHsgREVWRUxPUEVSX0FQSV9QUkVGSVggfSBmcm9tICcuL3N1cmZhY2VzLnRzJ1xuXG4vKiogQmFzZTY0IGNoYXJhY3RlcnMgcGVyIGNodW5rICh+MjU2IEtpQiBvZiBwYXlsb2FkIGJlZm9yZSBlbmNvZGluZykuICovXG5jb25zdCBDSFVOS19DSEFSUyA9IDI1NiAqIDEwMjRcbi8qKiBHZW5lcm91cyBjZWlsaW5nOiB0YXIgKyB0cmFuc2ZlciArIHVucGFjayArIGRlbm8gY2FjaGUgKyByZXN0YXJ0IGFjay4gKi9cbmNvbnN0IERFVl9TWU5DX1RJTUVPVVRfTVMgPSAxODBfMDAwXG5cbi8qKlxuICogQnVpbGQgYSBnemlwcGVkIHRhcmJhbGwgb2YgdGhlIGxvY2FsIGRhZW1vbiBjaGVja291dCwgZXhjbHVkaW5nIGhlYXZ5LFxuICogaG9zdC1zcGVjaWZpYywgb3IgZ2VuZXJhdGVkIHBhdGhzLiBSZXF1aXJlcyBgLS1hbGxvdy1ydW49dGFyYC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gYnVpbGREYWVtb25UYXJiYWxsKHJlcG86IHN0cmluZyk6IFByb21pc2U8VWludDhBcnJheT4ge1xuICBjb25zdCB0bXAgPSBhd2FpdCBEZW5vLm1ha2VUZW1wRmlsZSh7IHN1ZmZpeDogJy50Z3onIH0pXG4gIHRyeSB7XG4gICAgY29uc3QgY29tbWFuZCA9IG5ldyBEZW5vLkNvbW1hbmQoJ3RhcicsIHtcbiAgICAgIGFyZ3M6IFtcbiAgICAgICAgJy1jemYnLFxuICAgICAgICB0bXAsXG4gICAgICAgICctQycsXG4gICAgICAgIHJlcG8sXG4gICAgICAgICctLWV4Y2x1ZGU9Li8uZ2l0JyxcbiAgICAgICAgJy0tZXhjbHVkZT0uL29yY2hlc3RyYXRpb24vcnVudGltZScsXG4gICAgICAgICctLWV4Y2x1ZGU9Li9vcmNoZXN0cmF0aW9uL3JvbGVzJyxcbiAgICAgICAgJy0tZXhjbHVkZT0uL2Nsb3VkZmxhcmVkL3R1bm5lbHMnLFxuICAgICAgICAnLS1leGNsdWRlPS4vbm9kZV9tb2R1bGVzJyxcbiAgICAgICAgJy4nLFxuICAgICAgXSxcbiAgICAgIHN0ZG91dDogJ3BpcGVkJyxcbiAgICAgIHN0ZGVycjogJ3BpcGVkJyxcbiAgICB9KVxuICAgIGNvbnN0IG91dCA9IGF3YWl0IGNvbW1hbmQub3V0cHV0KClcbiAgICBpZiAoIW91dC5zdWNjZXNzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYHRhciBmYWlsZWQ6ICR7bmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKG91dC5zdGRlcnIpLnRyaW0oKX1gKVxuICAgIH1cbiAgICByZXR1cm4gYXdhaXQgRGVuby5yZWFkRmlsZSh0bXApXG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUodG1wKS5jYXRjaCgoKSA9PiB7fSlcbiAgfVxufVxuXG4vKipcbiAqIFBhY2thZ2UgdGhlIGluc3RhbmNlIGhvc3QncyBjdXJyZW50IGRhZW1vbiBidWlsZCBhbmQgc3RyZWFtIGl0IHRvIG9uZVxuICogY29ubmVjdGVkIGRhZW1vbiBvdmVyIHRoZSBXZWJTb2NrZXQsIHRoZW4gd2FpdCBmb3IgaXQgdG8gdW5wYWNrICsgcmVzdGFydC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN5bmNEZXZUb0RhZW1vbihkYWVtb25JZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRhcmJhbGwgPSBhd2FpdCBidWlsZERhZW1vblRhcmJhbGwoZ2V0RGFlbW9uUmVwb1BhdGgoKSlcbiAgY29uc3QgYmFzZTY0ID0gZW5jb2RlQmFzZTY0KHRhcmJhbGwpXG4gIGNvbnN0IGlkID0gY3J5cHRvLnJhbmRvbVVVSUQoKVxuICBjb25zdCB0b3RhbENodW5rcyA9IE1hdGgubWF4KDEsIE1hdGguY2VpbChiYXNlNjQubGVuZ3RoIC8gQ0hVTktfQ0hBUlMpKVxuXG4gIGNvbnN0IGJlZ2luOiBEYWVtb25NZXNzYWdlID0ge1xuICAgIHR5cGU6ICdkZXYtc3luYy1iZWdpbicsXG4gICAgaWQsXG4gICAgdG90YWxDaHVua3MsXG4gICAgdG90YWxCeXRlczogdGFyYmFsbC5ieXRlTGVuZ3RoLFxuICAgIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gIH1cbiAgaWYgKCFzZW5kVG9EYWVtb24oZGFlbW9uSWQsIGJlZ2luKSkge1xuICAgIHRocm93IG5ldyBFcnJvcignZGFlbW9uIG5vdCBjb25uZWN0ZWQnKVxuICB9XG5cbiAgY29uc3QgYWNrID0gYXdhaXREYWVtb25BY2soaWQsIERFVl9TWU5DX1RJTUVPVVRfTVMpXG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCB0b3RhbENodW5rczsgaSsrKSB7XG4gICAgY29uc3QgZGF0YSA9IGJhc2U2NC5zbGljZShpICogQ0hVTktfQ0hBUlMsIChpICsgMSkgKiBDSFVOS19DSEFSUylcbiAgICBzZW5kVG9EYWVtb24oZGFlbW9uSWQsIHtcbiAgICAgIHR5cGU6ICdkZXYtc3luYy1jaHVuaycsXG4gICAgICBpZCxcbiAgICAgIGluZGV4OiBpLFxuICAgICAgZGF0YSxcbiAgICAgIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgfSlcbiAgfVxuXG4gIHNlbmRUb0RhZW1vbihkYWVtb25JZCwgeyB0eXBlOiAnZGV2LXN5bmMtZW5kJywgaWQsIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSlcblxuICBhd2FpdCBhY2tcbn1cblxuLyoqXG4gKiBBZG1pbiByb3V0ZXMgdG8gcHVzaCB0aGUgY3VycmVudCBkZXYgZGFlbW9uIGJ1aWxkIHRvIGFnZW50cy4gRGVuby1vbmx5OiB0YXIgK1xuICogZmlsZXN5c3RlbSBhY2Nlc3MgYXJlIG5vdCBhdmFpbGFibGUgaW4gdGhlIFdvcmtlcnMgYnVpbGQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlckRldlN5bmNSb3V0ZXMoXG4gIGFwcDogSG9ubyxcbiAgb3B0czogeyBzZXNzaW9uU2VjcmV0OiBzdHJpbmcgfSxcbik6IEhvbm8ge1xuICBhcHAudXNlKGAke0RFVkVMT1BFUl9BUElfUFJFRklYfS9kYWVtb24vc3luYy1kZXZgLCBjcmVhdGVSb290T25seU1pZGRsZXdhcmUob3B0cy5zZXNzaW9uU2VjcmV0KSlcbiAgYXBwLnVzZShgJHtERVZFTE9QRVJfQVBJX1BSRUZJWH0vZGFlbW9uLzppZC9zeW5jLWRldmAsIGNyZWF0ZVJvb3RPbmx5TWlkZGxld2FyZShvcHRzLnNlc3Npb25TZWNyZXQpKVxuXG4gIGFwcC5wb3N0KGAke0RFVkVMT1BFUl9BUElfUFJFRklYfS9kYWVtb24vOmlkL3N5bmMtZGV2YCwgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBpZCA9IGMucmVxLnBhcmFtKCdpZCcpXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHN5bmNEZXZUb0RhZW1vbihpZClcbiAgICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSwgZGFlbW9uSWQ6IGlkIH0pXG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICBjb25zdCBzdGF0dXMgPSBtZXNzYWdlID09PSAnZGFlbW9uIG5vdCBjb25uZWN0ZWQnID8gNDA0IDogNTAwXG4gICAgICByZXR1cm4gYy5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogbWVzc2FnZSB9LCBzdGF0dXMpXG4gICAgfVxuICB9KVxuXG4gIGFwcC5wb3N0KGAke0RFVkVMT1BFUl9BUElfUFJFRklYfS9kYWVtb24vc3luYy1kZXZgLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBQcm9taXNlLmFsbChcbiAgICAgIGxpc3REYWVtb25Db25uZWN0aW9ucygpLm1hcChhc3luYyAoY29ubikgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGF3YWl0IHN5bmNEZXZUb0RhZW1vbihjb25uLmlkKVxuICAgICAgICAgIHJldHVybiB7IGRhZW1vbklkOiBjb25uLmlkLCBvazogdHJ1ZSB9XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBkYWVtb25JZDogY29ubi5pZCxcbiAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9KSxcbiAgICApXG4gICAgcmV0dXJuIGMuanNvbih7IG9rOiByZXN1bHRzLmV2ZXJ5KChyKSA9PiByLm9rKSwgcmVzdWx0cyB9KVxuICB9KVxuXG4gIHJldHVybiBhcHBcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFDQSxTQUFTLHdCQUF3QixRQUFRLHVCQUFzQjtBQUMvRCxTQUFTLFlBQVksUUFBUSw2QkFBNEI7QUFDekQsU0FDRSxjQUFjLEVBRWQscUJBQXFCLEVBQ3JCLFlBQVksUUFDUCxrQkFBaUI7QUFDeEIsU0FBUyxpQkFBaUIsUUFBUSxzQkFBcUI7QUFDdkQsU0FBUyxvQkFBb0IsUUFBUSxnQkFBZTtBQUVwRCx1RUFBdUUs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
// denoCacheMetadata=11146547925560008172,10378353815188552542