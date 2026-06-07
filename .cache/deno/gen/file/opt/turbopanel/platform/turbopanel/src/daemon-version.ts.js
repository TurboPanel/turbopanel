import { dirname, fromFileUrl, join } from 'jsr:@std/path@1';
import { DAEMON_API_PREFIX } from './surfaces.ts';
/**
 * Canonical commit the connected daemons (agent nodes) should be running.
 *
 * This is the HEAD of the daemon repository checkout that lives alongside the
 * instance on this host (`../daemon`, override with `TURBOPANEL_DAEMON_REPO`).
 * Agents compare their own checkout against this and self-update on mismatch.
 *
 * Deno-only: it shells out to `git` and reads the daemon working tree, so it is
 * registered from `deno.ts` rather than the shared `createApp()` used by Workers.
 */ const TURBOPANEL_ROOT = (()=>{
  // This module lives at <root>/src/daemon-version.ts.
  const here = dirname(fromFileUrl(import.meta.url));
  return join(here, '..');
})();
export function getDaemonRepoPath() {
  const override = Deno.env.get('TURBOPANEL_DAEMON_REPO')?.trim();
  if (override) return override;
  return join(TURBOPANEL_ROOT, '..', 'daemon');
}
const TTL_MS = 5_000;
let cache = null;
async function gitOutput(repo, args) {
  try {
    const command = new Deno.Command('git', {
      args: [
        '-C',
        repo,
        ...args
      ],
      stdout: 'piped',
      stderr: 'null'
    });
    const { success, stdout } = await command.output();
    if (!success) return null;
    return new TextDecoder().decode(stdout).trim();
  } catch  {
    return null;
  }
}
/**
 * Read the daemon checkout's commit + branch.
 *
 * Cached briefly so the WS push interval and the REST endpoint don't fork `git`
 * on every call. Pass `force` to bypass the cache (used by the change watcher).
 */ export async function getDaemonCommit(force = false) {
  const now = Date.now();
  if (!force && cache && now - cache.at < TTL_MS) return cache.value;
  const repo = getDaemonRepoPath();
  const commit = await gitOutput(repo, [
    'rev-parse',
    'HEAD'
  ]) ?? 'unknown';
  const branch = await gitOutput(repo, [
    'rev-parse',
    '--abbrev-ref',
    'HEAD'
  ]) ?? 'unknown';
  const value = {
    commit,
    branch
  };
  cache = {
    value,
    at: now
  };
  return value;
}
/** Read the instance repo's own HEAD (not cached). */ export async function getInstanceCommit() {
  const commit = await gitOutput(TURBOPANEL_ROOT, [
    'rev-parse',
    'HEAD'
  ]) ?? 'unknown';
  const branch = await gitOutput(TURBOPANEL_ROOT, [
    'rev-parse',
    '--abbrev-ref',
    'HEAD'
  ]) ?? 'unknown';
  return {
    commit,
    branch
  };
}
export function registerVersionRoute(app) {
  app.get(`${DAEMON_API_PREFIX}/version`, async (c)=>c.json(await getDaemonCommit()));
  return app;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vb3B0L3R1cmJvcGFuZWwvcGxhdGZvcm0vdHVyYm9wYW5lbC9zcmMvZGFlbW9uLXZlcnNpb24udHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBIb25vIH0gZnJvbSAnaG9ubydcbmltcG9ydCB7IGRpcm5hbWUsIGZyb21GaWxlVXJsLCBqb2luIH0gZnJvbSAnanNyOkBzdGQvcGF0aEAxJ1xuaW1wb3J0IHsgREFFTU9OX0FQSV9QUkVGSVggfSBmcm9tICcuL3N1cmZhY2VzLnRzJ1xuXG4vKipcbiAqIENhbm9uaWNhbCBjb21taXQgdGhlIGNvbm5lY3RlZCBkYWVtb25zIChhZ2VudCBub2Rlcykgc2hvdWxkIGJlIHJ1bm5pbmcuXG4gKlxuICogVGhpcyBpcyB0aGUgSEVBRCBvZiB0aGUgZGFlbW9uIHJlcG9zaXRvcnkgY2hlY2tvdXQgdGhhdCBsaXZlcyBhbG9uZ3NpZGUgdGhlXG4gKiBpbnN0YW5jZSBvbiB0aGlzIGhvc3QgKGAuLi9kYWVtb25gLCBvdmVycmlkZSB3aXRoIGBUVVJCT1BBTkVMX0RBRU1PTl9SRVBPYCkuXG4gKiBBZ2VudHMgY29tcGFyZSB0aGVpciBvd24gY2hlY2tvdXQgYWdhaW5zdCB0aGlzIGFuZCBzZWxmLXVwZGF0ZSBvbiBtaXNtYXRjaC5cbiAqXG4gKiBEZW5vLW9ubHk6IGl0IHNoZWxscyBvdXQgdG8gYGdpdGAgYW5kIHJlYWRzIHRoZSBkYWVtb24gd29ya2luZyB0cmVlLCBzbyBpdCBpc1xuICogcmVnaXN0ZXJlZCBmcm9tIGBkZW5vLnRzYCByYXRoZXIgdGhhbiB0aGUgc2hhcmVkIGBjcmVhdGVBcHAoKWAgdXNlZCBieSBXb3JrZXJzLlxuICovXG5cbmNvbnN0IFRVUkJPUEFORUxfUk9PVCA9ICgoKSA9PiB7XG4gIC8vIFRoaXMgbW9kdWxlIGxpdmVzIGF0IDxyb290Pi9zcmMvZGFlbW9uLXZlcnNpb24udHMuXG4gIGNvbnN0IGhlcmUgPSBkaXJuYW1lKGZyb21GaWxlVXJsKGltcG9ydC5tZXRhLnVybCkpXG4gIHJldHVybiBqb2luKGhlcmUsICcuLicpXG59KSgpXG5cbmV4cG9ydCBmdW5jdGlvbiBnZXREYWVtb25SZXBvUGF0aCgpOiBzdHJpbmcge1xuICBjb25zdCBvdmVycmlkZSA9IERlbm8uZW52LmdldCgnVFVSQk9QQU5FTF9EQUVNT05fUkVQTycpPy50cmltKClcbiAgaWYgKG92ZXJyaWRlKSByZXR1cm4gb3ZlcnJpZGVcbiAgcmV0dXJuIGpvaW4oVFVSQk9QQU5FTF9ST09ULCAnLi4nLCAnZGFlbW9uJylcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEYWVtb25WZXJzaW9uIHtcbiAgY29tbWl0OiBzdHJpbmdcbiAgYnJhbmNoOiBzdHJpbmdcbn1cblxuY29uc3QgVFRMX01TID0gNV8wMDBcbmxldCBjYWNoZTogeyB2YWx1ZTogRGFlbW9uVmVyc2lvbjsgYXQ6IG51bWJlciB9IHwgbnVsbCA9IG51bGxcblxuYXN5bmMgZnVuY3Rpb24gZ2l0T3V0cHV0KHJlcG86IHN0cmluZywgYXJnczogc3RyaW5nW10pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IERlbm8uQ29tbWFuZCgnZ2l0Jywge1xuICAgICAgYXJnczogWyctQycsIHJlcG8sIC4uLmFyZ3NdLFxuICAgICAgc3Rkb3V0OiAncGlwZWQnLFxuICAgICAgc3RkZXJyOiAnbnVsbCcsXG4gICAgfSlcbiAgICBjb25zdCB7IHN1Y2Nlc3MsIHN0ZG91dCB9ID0gYXdhaXQgY29tbWFuZC5vdXRwdXQoKVxuICAgIGlmICghc3VjY2VzcykgcmV0dXJuIG51bGxcbiAgICByZXR1cm4gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHN0ZG91dCkudHJpbSgpXG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsXG4gIH1cbn1cblxuLyoqXG4gKiBSZWFkIHRoZSBkYWVtb24gY2hlY2tvdXQncyBjb21taXQgKyBicmFuY2guXG4gKlxuICogQ2FjaGVkIGJyaWVmbHkgc28gdGhlIFdTIHB1c2ggaW50ZXJ2YWwgYW5kIHRoZSBSRVNUIGVuZHBvaW50IGRvbid0IGZvcmsgYGdpdGBcbiAqIG9uIGV2ZXJ5IGNhbGwuIFBhc3MgYGZvcmNlYCB0byBieXBhc3MgdGhlIGNhY2hlICh1c2VkIGJ5IHRoZSBjaGFuZ2Ugd2F0Y2hlcikuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXREYWVtb25Db21taXQoZm9yY2UgPSBmYWxzZSk6IFByb21pc2U8RGFlbW9uVmVyc2lvbj4ge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpXG4gIGlmICghZm9yY2UgJiYgY2FjaGUgJiYgbm93IC0gY2FjaGUuYXQgPCBUVExfTVMpIHJldHVybiBjYWNoZS52YWx1ZVxuXG4gIGNvbnN0IHJlcG8gPSBnZXREYWVtb25SZXBvUGF0aCgpXG4gIGNvbnN0IGNvbW1pdCA9IChhd2FpdCBnaXRPdXRwdXQocmVwbywgWydyZXYtcGFyc2UnLCAnSEVBRCddKSkgPz8gJ3Vua25vd24nXG4gIGNvbnN0IGJyYW5jaCA9XG4gICAgKGF3YWl0IGdpdE91dHB1dChyZXBvLCBbJ3Jldi1wYXJzZScsICctLWFiYnJldi1yZWYnLCAnSEVBRCddKSkgPz8gJ3Vua25vd24nXG5cbiAgY29uc3QgdmFsdWU6IERhZW1vblZlcnNpb24gPSB7IGNvbW1pdCwgYnJhbmNoIH1cbiAgY2FjaGUgPSB7IHZhbHVlLCBhdDogbm93IH1cbiAgcmV0dXJuIHZhbHVlXG59XG5cbi8qKiBSZWFkIHRoZSBpbnN0YW5jZSByZXBvJ3Mgb3duIEhFQUQgKG5vdCBjYWNoZWQpLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEluc3RhbmNlQ29tbWl0KCk6IFByb21pc2U8RGFlbW9uVmVyc2lvbj4ge1xuICBjb25zdCBjb21taXQgPVxuICAgIChhd2FpdCBnaXRPdXRwdXQoVFVSQk9QQU5FTF9ST09ULCBbJ3Jldi1wYXJzZScsICdIRUFEJ10pKSA/PyAndW5rbm93bidcbiAgY29uc3QgYnJhbmNoID1cbiAgICAoYXdhaXQgZ2l0T3V0cHV0KFRVUkJPUEFORUxfUk9PVCwgWydyZXYtcGFyc2UnLCAnLS1hYmJyZXYtcmVmJywgJ0hFQUQnXSkpID8/XG4gICAgICAndW5rbm93bidcbiAgcmV0dXJuIHsgY29tbWl0LCBicmFuY2ggfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJWZXJzaW9uUm91dGUoYXBwOiBIb25vKTogSG9ubyB7XG4gIGFwcC5nZXQoYCR7REFFTU9OX0FQSV9QUkVGSVh9L3ZlcnNpb25gLCBhc3luYyAoYykgPT4gYy5qc29uKGF3YWl0IGdldERhZW1vbkNvbW1pdCgpKSlcbiAgcmV0dXJuIGFwcFxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLFNBQVMsT0FBTyxFQUFFLFdBQVcsRUFBRSxJQUFJLFFBQVEsa0JBQWlCO0FBQzVELFNBQVMsaUJBQWlCLFFBQVEsZ0JBQWU7QUFFakQ7Ozs7Ozs7OztDQVNDLEdBRUQsTUFBTSxrQkFBa0IsQ0FBQztFQUN2QixxREFBcUQ7RUFDckQsTUFBTSxPQUFPLFFBQVEsWUFBWSxZQUFZLEdBQUc7RUFDaEQsT0FBTyxLQUFLLE1BQU07QUFDcEIsQ0FBQztBQUVELE9BQU8sU0FBUztFQUNkLE1BQU0sV0FBVyxLQUFLLEdBQUcsQ0FBQyxHQUFHLENBQUMsMkJBQTJCO0VBQ3pELElBQUksVUFBVSxPQUFPO0VBQ3JCLE9BQU8sS0FBSyxpQkFBaUIsTUFBTTtBQUNyQztBQU9BLE1BQU0sU0FBUztBQUNmLElBQUksUUFBcUQ7QUFFekQsZUFBZSxVQUFVLElBQVksRUFBRSxJQUFjO0VBQ25ELElBQUk7SUFDRixNQUFNLFVBQVUsSUFBSSxLQUFLLE9BQU8sQ0FBQyxPQUFPO01BQ3RDLE1BQU07UUFBQztRQUFNO1dBQVM7T0FBSztNQUMzQixRQUFRO01BQ1IsUUFBUTtJQUNWO0lBQ0EsTUFBTSxFQUFFLE9BQU8sRUFBRSxNQUFNLEVBQUUsR0FBRyxNQUFNLFFBQVEsTUFBTTtJQUNoRCxJQUFJLENBQUMsU0FBUyxPQUFPO0lBQ3JCLE9BQU8sSUFBSSxjQUFjLE1BQU0sQ0FBQyxRQUFRLElBQUk7RUFDOUMsRUFBRSxPQUFNO0lBQ04sT0FBTztFQUNUO0FBQ0Y7QUFFQTs7Ozs7Q0FLQyxHQUNELE9BQU8sZUFBZSxnQkFBZ0IsUUFBUSxLQUFLO0VBQ2pELE1BQU0sTUFBTSxLQUFLLEdBQUc7RUFDcEIsSUFBSSxDQUFDLFNBQVMsU0FBUyxNQUFNLE1BQU0sRUFBRSxHQUFHLFFBQVEsT0FBTyxNQUFNLEtBQUs7RUFFbEUsTUFBTSxPQUFPO0VBQ2IsTUFBTSxTQUFTLEFBQUMsTUFBTSxVQUFVLE1BQU07SUFBQztJQUFhO0dBQU8sS0FBTTtFQUNqRSxNQUFNLFNBQ0osQUFBQyxNQUFNLFVBQVUsTUFBTTtJQUFDO0lBQWE7SUFBZ0I7R0FBTyxLQUFNO0VBRXBFLE1BQU0sUUFBdUI7SUFBRTtJQUFRO0VBQU87RUFDOUMsUUFBUTtJQUFFO0lBQU8sSUFBSTtFQUFJO0VBQ3pCLE9BQU87QUFDVDtBQUVBLG9EQUFvRCxHQUNwRCxPQUFPLGVBQWU7RUFDcEIsTUFBTSxTQUNKLEFBQUMsTUFBTSxVQUFVLGlCQUFpQjtJQUFDO0lBQWE7R0FBTyxLQUFNO0VBQy9ELE1BQU0sU0FDSixBQUFDLE1BQU0sVUFBVSxpQkFBaUI7SUFBQztJQUFhO0lBQWdCO0dBQU8sS0FDckU7RUFDSixPQUFPO0lBQUU7SUFBUTtFQUFPO0FBQzFCO0FBRUEsT0FBTyxTQUFTLHFCQUFxQixHQUFTO0VBQzVDLElBQUksR0FBRyxDQUFDLEdBQUcsa0JBQWtCLFFBQVEsQ0FBQyxFQUFFLE9BQU8sSUFBTSxFQUFFLElBQUksQ0FBQyxNQUFNO0VBQ2xFLE9BQU87QUFDVCJ9
// denoCacheMetadata=11115750278001477021,18028715512811454192