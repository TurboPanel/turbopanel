import { getDaemonRepoPath, getInstanceCommit } from './daemon-version.ts';
import { dirname, fromFileUrl, join } from 'jsr:@std/path@1';
import { DEVELOPER_API_PREFIX } from './surfaces.ts';
const INSTANCE_REPO_ROOT = (()=>{
  const here = dirname(fromFileUrl(import.meta.url));
  return join(here, '..');
})();
const TRUNK_BRANCH = Deno.env.get('TURBOPANEL_TRUNK_BRANCH')?.trim() || 'trunk';
const INSTANCE_SERVICE = Deno.env.get('TURBOPANEL_INSTANCE_SERVICE')?.trim();
let upgrading = false;
/** Run git as turbopanel so the deploy key stays mode 0600 (SSH rejects group-readable keys). */ async function git(repoRoot, args) {
  try {
    const command = new Deno.Command('sudo', {
      args: [
        '-u',
        'turbopanel',
        'git',
        '-C',
        repoRoot,
        ...args
      ],
      stdout: 'piped',
      stderr: 'piped'
    });
    const out = await command.output();
    const decoder = new TextDecoder();
    return {
      success: out.success,
      stdout: decoder.decode(out.stdout).trim(),
      stderr: decoder.decode(out.stderr).trim()
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      stdout: '',
      stderr: message
    };
  }
}
async function syncRepoToTrunk(repoRoot, label) {
  const fetched = await git(repoRoot, [
    'fetch',
    'origin',
    TRUNK_BRANCH
  ]);
  if (!fetched.success) {
    return {
      ok: false,
      error: `${label} git fetch failed: ${fetched.stderr}`
    };
  }
  const reset = await git(repoRoot, [
    'reset',
    '--hard',
    `origin/${TRUNK_BRANCH}`
  ]);
  if (!reset.success) {
    return {
      ok: false,
      error: `${label} git reset failed: ${reset.stderr}`
    };
  }
  return {
    ok: true
  };
}
export function registerSystemRoutes(app) {
  app.post(`${DEVELOPER_API_PREFIX}/system/upgrade`, async (c)=>{
    if (upgrading) {
      return c.json({
        ok: false,
        error: 'upgrade already in progress'
      }, 409);
    }
    if (!INSTANCE_SERVICE) {
      return c.json({
        ok: false,
        error: 'instance upgrade restart unavailable: TURBOPANEL_INSTANCE_SERVICE is not set (run under systemd or configure a managed service)'
      }, 503);
    }
    upgrading = true;
    try {
      // #region agent log
      Deno.writeTextFile('/run/turbopanel/debug-e3dc28.log', `${JSON.stringify({
        sessionId: 'e3dc28',
        runId: 'upgrade-fix-v2',
        hypothesisId: 'H4',
        location: 'system-routes.ts:upgrade',
        message: 'starting upgrade via sudo -u turbopanel git',
        data: {
          instanceService: INSTANCE_SERVICE ?? null
        },
        timestamp: Date.now()
      })}\n`, {
        append: true
      }).catch(()=>{});
      // #endregion
      const instanceSync = await syncRepoToTrunk(INSTANCE_REPO_ROOT, 'instance');
      // #region agent log
      Deno.writeTextFile('/run/turbopanel/debug-e3dc28.log', `${JSON.stringify({
        sessionId: 'e3dc28',
        runId: 'upgrade-fix-v2',
        hypothesisId: 'H4',
        location: 'system-routes.ts:upgrade',
        message: 'instance sync result',
        data: {
          ok: instanceSync.ok,
          error: instanceSync.ok ? null : instanceSync.error
        },
        timestamp: Date.now()
      })}\n`, {
        append: true
      }).catch(()=>{});
      // #endregion
      if (!instanceSync.ok) {
        return c.json({
          ok: false,
          error: instanceSync.error
        }, 500);
      }
      const daemonSync = await syncRepoToTrunk(getDaemonRepoPath(), 'daemon');
      if (!daemonSync.ok) {
        return c.json({
          ok: false,
          error: daemonSync.error
        }, 500);
      }
      const instanceVersion = await getInstanceCommit();
      const restart = await new Deno.Command('sudo', {
        args: [
          'systemctl',
          'restart',
          INSTANCE_SERVICE
        ],
        stdin: 'null',
        stdout: 'piped',
        stderr: 'piped'
      }).output();
      // #region agent log
      Deno.writeTextFile('/run/turbopanel/debug-e3dc28.log', `${JSON.stringify({
        sessionId: 'e3dc28',
        runId: 'upgrade-fix-v2',
        hypothesisId: 'H2',
        location: 'system-routes.ts:upgrade',
        message: 'systemctl restart result',
        data: {
          success: restart.success,
          stderr: new TextDecoder().decode(restart.stderr).trim().slice(0, 300)
        },
        timestamp: Date.now()
      })}\n`, {
        append: true
      }).catch(()=>{});
      // #endregion
      if (!restart.success) {
        const err = new TextDecoder().decode(restart.stderr).trim();
        return c.json({
          ok: false,
          error: `repos updated but systemctl restart ${INSTANCE_SERVICE} failed: ${err || 'unknown error'}`
        }, 500);
      }
      return c.json({
        ok: true,
        commit: instanceVersion.commit
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({
        ok: false,
        error: message
      }, 500);
    } finally{
      upgrading = false;
    }
  });
  return app;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vb3B0L3R1cmJvcGFuZWwvcGxhdGZvcm0vdHVyYm9wYW5lbC9zcmMvc3lzdGVtLXJvdXRlcy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBIb25vIH0gZnJvbSAnaG9ubydcbmltcG9ydCB7IGdldERhZW1vblJlcG9QYXRoLCBnZXRJbnN0YW5jZUNvbW1pdCB9IGZyb20gJy4vZGFlbW9uLXZlcnNpb24udHMnXG5pbXBvcnQgeyBkaXJuYW1lLCBmcm9tRmlsZVVybCwgam9pbiB9IGZyb20gJ2pzcjpAc3RkL3BhdGhAMSdcbmltcG9ydCB7IERFVkVMT1BFUl9BUElfUFJFRklYIH0gZnJvbSAnLi9zdXJmYWNlcy50cydcblxuY29uc3QgSU5TVEFOQ0VfUkVQT19ST09UID0gKCgpID0+IHtcbiAgY29uc3QgaGVyZSA9IGRpcm5hbWUoZnJvbUZpbGVVcmwoaW1wb3J0Lm1ldGEudXJsKSlcbiAgcmV0dXJuIGpvaW4oaGVyZSwgJy4uJylcbn0pKClcblxuY29uc3QgVFJVTktfQlJBTkNIID0gRGVuby5lbnYuZ2V0KCdUVVJCT1BBTkVMX1RSVU5LX0JSQU5DSCcpPy50cmltKCkgfHwgJ3RydW5rJ1xuY29uc3QgSU5TVEFOQ0VfU0VSVklDRSA9IERlbm8uZW52LmdldCgnVFVSQk9QQU5FTF9JTlNUQU5DRV9TRVJWSUNFJyk/LnRyaW0oKVxuXG5sZXQgdXBncmFkaW5nID0gZmFsc2VcblxuLyoqIFJ1biBnaXQgYXMgdHVyYm9wYW5lbCBzbyB0aGUgZGVwbG95IGtleSBzdGF5cyBtb2RlIDA2MDAgKFNTSCByZWplY3RzIGdyb3VwLXJlYWRhYmxlIGtleXMpLiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2l0KFxuICByZXBvUm9vdDogc3RyaW5nLFxuICBhcmdzOiBzdHJpbmdbXSxcbik6IFByb21pc2U8eyBzdWNjZXNzOiBib29sZWFuOyBzdGRvdXQ6IHN0cmluZzsgc3RkZXJyOiBzdHJpbmcgfT4ge1xuICB0cnkge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgRGVuby5Db21tYW5kKCdzdWRvJywge1xuICAgICAgYXJnczogWyctdScsICd0dXJib3BhbmVsJywgJ2dpdCcsICctQycsIHJlcG9Sb290LCAuLi5hcmdzXSxcbiAgICAgIHN0ZG91dDogJ3BpcGVkJyxcbiAgICAgIHN0ZGVycjogJ3BpcGVkJyxcbiAgICB9KVxuICAgIGNvbnN0IG91dCA9IGF3YWl0IGNvbW1hbmQub3V0cHV0KClcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKClcbiAgICByZXR1cm4ge1xuICAgICAgc3VjY2Vzczogb3V0LnN1Y2Nlc3MsXG4gICAgICBzdGRvdXQ6IGRlY29kZXIuZGVjb2RlKG91dC5zdGRvdXQpLnRyaW0oKSxcbiAgICAgIHN0ZGVycjogZGVjb2Rlci5kZWNvZGUob3V0LnN0ZGVycikudHJpbSgpLFxuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBzdGRvdXQ6ICcnLCBzdGRlcnI6IG1lc3NhZ2UgfVxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN5bmNSZXBvVG9UcnVuayhcbiAgcmVwb1Jvb3Q6IHN0cmluZyxcbiAgbGFiZWw6IHN0cmluZyxcbik6IFByb21pc2U8eyBvazogdHJ1ZSB9IHwgeyBvazogZmFsc2U7IGVycm9yOiBzdHJpbmcgfT4ge1xuICBjb25zdCBmZXRjaGVkID0gYXdhaXQgZ2l0KHJlcG9Sb290LCBbJ2ZldGNoJywgJ29yaWdpbicsIFRSVU5LX0JSQU5DSF0pXG4gIGlmICghZmV0Y2hlZC5zdWNjZXNzKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBgJHtsYWJlbH0gZ2l0IGZldGNoIGZhaWxlZDogJHtmZXRjaGVkLnN0ZGVycn1gLFxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHJlc2V0ID0gYXdhaXQgZ2l0KHJlcG9Sb290LCBbJ3Jlc2V0JywgJy0taGFyZCcsIGBvcmlnaW4vJHtUUlVOS19CUkFOQ0h9YF0pXG4gIGlmICghcmVzZXQuc3VjY2Vzcykge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogYCR7bGFiZWx9IGdpdCByZXNldCBmYWlsZWQ6ICR7cmVzZXQuc3RkZXJyfWAsXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJTeXN0ZW1Sb3V0ZXMoYXBwOiBIb25vKTogSG9ubyB7XG4gIGFwcC5wb3N0KGAke0RFVkVMT1BFUl9BUElfUFJFRklYfS9zeXN0ZW0vdXBncmFkZWAsIGFzeW5jIChjKSA9PiB7XG4gICAgaWYgKHVwZ3JhZGluZykge1xuICAgICAgcmV0dXJuIGMuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6ICd1cGdyYWRlIGFscmVhZHkgaW4gcHJvZ3Jlc3MnIH0sIDQwOSlcbiAgICB9XG4gICAgaWYgKCFJTlNUQU5DRV9TRVJWSUNFKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7XG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIGVycm9yOlxuICAgICAgICAgICAgJ2luc3RhbmNlIHVwZ3JhZGUgcmVzdGFydCB1bmF2YWlsYWJsZTogVFVSQk9QQU5FTF9JTlNUQU5DRV9TRVJWSUNFIGlzIG5vdCBzZXQgKHJ1biB1bmRlciBzeXN0ZW1kIG9yIGNvbmZpZ3VyZSBhIG1hbmFnZWQgc2VydmljZSknLFxuICAgICAgICB9LFxuICAgICAgICA1MDMsXG4gICAgICApXG4gICAgfVxuXG4gICAgdXBncmFkaW5nID0gdHJ1ZVxuICAgIHRyeSB7XG4gICAgICAvLyAjcmVnaW9uIGFnZW50IGxvZ1xuICAgICAgRGVuby53cml0ZVRleHRGaWxlKCcvcnVuL3R1cmJvcGFuZWwvZGVidWctZTNkYzI4LmxvZycsIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgc2Vzc2lvbklkOiAnZTNkYzI4JywgcnVuSWQ6ICd1cGdyYWRlLWZpeC12MicsIGh5cG90aGVzaXNJZDogJ0g0JyxcbiAgICAgICAgbG9jYXRpb246ICdzeXN0ZW0tcm91dGVzLnRzOnVwZ3JhZGUnLCBtZXNzYWdlOiAnc3RhcnRpbmcgdXBncmFkZSB2aWEgc3VkbyAtdSB0dXJib3BhbmVsIGdpdCcsXG4gICAgICAgIGRhdGE6IHsgaW5zdGFuY2VTZXJ2aWNlOiBJTlNUQU5DRV9TRVJWSUNFID8/IG51bGwgfSxcbiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgfSl9XFxuYCwgeyBhcHBlbmQ6IHRydWUgfSkuY2F0Y2goKCkgPT4ge30pXG4gICAgICAvLyAjZW5kcmVnaW9uXG4gICAgICBjb25zdCBpbnN0YW5jZVN5bmMgPSBhd2FpdCBzeW5jUmVwb1RvVHJ1bmsoSU5TVEFOQ0VfUkVQT19ST09ULCAnaW5zdGFuY2UnKVxuICAgICAgLy8gI3JlZ2lvbiBhZ2VudCBsb2dcbiAgICAgIERlbm8ud3JpdGVUZXh0RmlsZSgnL3J1bi90dXJib3BhbmVsL2RlYnVnLWUzZGMyOC5sb2cnLCBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHNlc3Npb25JZDogJ2UzZGMyOCcsIHJ1bklkOiAndXBncmFkZS1maXgtdjInLCBoeXBvdGhlc2lzSWQ6ICdINCcsXG4gICAgICAgIGxvY2F0aW9uOiAnc3lzdGVtLXJvdXRlcy50czp1cGdyYWRlJywgbWVzc2FnZTogJ2luc3RhbmNlIHN5bmMgcmVzdWx0JyxcbiAgICAgICAgZGF0YTogeyBvazogaW5zdGFuY2VTeW5jLm9rLCBlcnJvcjogaW5zdGFuY2VTeW5jLm9rID8gbnVsbCA6IGluc3RhbmNlU3luYy5lcnJvciB9LFxuICAgICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgICB9KX1cXG5gLCB7IGFwcGVuZDogdHJ1ZSB9KS5jYXRjaCgoKSA9PiB7fSlcbiAgICAgIC8vICNlbmRyZWdpb25cbiAgICAgIGlmICghaW5zdGFuY2VTeW5jLm9rKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBpbnN0YW5jZVN5bmMuZXJyb3IgfSwgNTAwKVxuICAgICAgfVxuXG4gICAgICBjb25zdCBkYWVtb25TeW5jID0gYXdhaXQgc3luY1JlcG9Ub1RydW5rKGdldERhZW1vblJlcG9QYXRoKCksICdkYWVtb24nKVxuICAgICAgaWYgKCFkYWVtb25TeW5jLm9rKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oeyBvazogZmFsc2UsIGVycm9yOiBkYWVtb25TeW5jLmVycm9yIH0sIDUwMClcbiAgICAgIH1cblxuICAgICAgY29uc3QgaW5zdGFuY2VWZXJzaW9uID0gYXdhaXQgZ2V0SW5zdGFuY2VDb21taXQoKVxuXG4gICAgICBjb25zdCByZXN0YXJ0ID0gYXdhaXQgbmV3IERlbm8uQ29tbWFuZCgnc3VkbycsIHtcbiAgICAgICAgYXJnczogWydzeXN0ZW1jdGwnLCAncmVzdGFydCcsIElOU1RBTkNFX1NFUlZJQ0VdLFxuICAgICAgICBzdGRpbjogJ251bGwnLFxuICAgICAgICBzdGRvdXQ6ICdwaXBlZCcsXG4gICAgICAgIHN0ZGVycjogJ3BpcGVkJyxcbiAgICAgIH0pLm91dHB1dCgpXG4gICAgICAvLyAjcmVnaW9uIGFnZW50IGxvZ1xuICAgICAgRGVuby53cml0ZVRleHRGaWxlKCcvcnVuL3R1cmJvcGFuZWwvZGVidWctZTNkYzI4LmxvZycsIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgc2Vzc2lvbklkOiAnZTNkYzI4JywgcnVuSWQ6ICd1cGdyYWRlLWZpeC12MicsIGh5cG90aGVzaXNJZDogJ0gyJyxcbiAgICAgICAgbG9jYXRpb246ICdzeXN0ZW0tcm91dGVzLnRzOnVwZ3JhZGUnLCBtZXNzYWdlOiAnc3lzdGVtY3RsIHJlc3RhcnQgcmVzdWx0JyxcbiAgICAgICAgZGF0YToge1xuICAgICAgICAgIHN1Y2Nlc3M6IHJlc3RhcnQuc3VjY2VzcyxcbiAgICAgICAgICBzdGRlcnI6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyZXN0YXJ0LnN0ZGVycikudHJpbSgpLnNsaWNlKDAsIDMwMCksXG4gICAgICAgIH0sXG4gICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgIH0pfVxcbmAsIHsgYXBwZW5kOiB0cnVlIH0pLmNhdGNoKCgpID0+IHt9KVxuICAgICAgLy8gI2VuZHJlZ2lvblxuICAgICAgaWYgKCFyZXN0YXJ0LnN1Y2Nlc3MpIHtcbiAgICAgICAgY29uc3QgZXJyID0gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJlc3RhcnQuc3RkZXJyKS50cmltKClcbiAgICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAgICB7XG4gICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICBlcnJvcjogYHJlcG9zIHVwZGF0ZWQgYnV0IHN5c3RlbWN0bCByZXN0YXJ0ICR7SU5TVEFOQ0VfU0VSVklDRX0gZmFpbGVkOiAke1xuICAgICAgICAgICAgICBlcnIgfHwgJ3Vua25vd24gZXJyb3InXG4gICAgICAgICAgICB9YCxcbiAgICAgICAgICB9LFxuICAgICAgICAgIDUwMCxcbiAgICAgICAgKVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIGNvbW1pdDogaW5zdGFuY2VWZXJzaW9uLmNvbW1pdCB9KVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgcmV0dXJuIGMuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IG1lc3NhZ2UgfSwgNTAwKVxuICAgIH0gZmluYWxseSB7XG4gICAgICB1cGdyYWRpbmcgPSBmYWxzZVxuICAgIH1cbiAgfSlcblxuICByZXR1cm4gYXBwXG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQ0EsU0FBUyxpQkFBaUIsRUFBRSxpQkFBaUIsUUFBUSxzQkFBcUI7QUFDMUUsU0FBUyxPQUFPLEVBQUUs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
// denoCacheMetadata=4875369339799062624,1314600741167241159