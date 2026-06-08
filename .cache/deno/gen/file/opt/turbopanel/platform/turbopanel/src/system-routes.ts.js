import { createRootOnlyMiddleware } from './auth/middleware.ts';
import { getDaemonRepoPath, getInstanceCommit } from './daemon-version.ts';
import { dirname, fromFileUrl, join } from 'jsr:@std/path@1';
import { DEVELOPER_API_PREFIX } from './surfaces.ts';
const INSTANCE_REPO_ROOT = (()=>{
  const here = dirname(fromFileUrl(import.meta.url));
  return join(here, '..');
})();
function getUiRepoPath() {
  const override = Deno.env.get('TURBOPANEL_UI_REPO')?.trim();
  if (override) return override;
  return join(INSTANCE_REPO_ROOT, '..', 'ui');
}
/** Platform checkouts Upgrade System may reset — all must be clean first. */ const PLATFORM_REPOS = [
  {
    name: 'instance',
    path: INSTANCE_REPO_ROOT
  },
  {
    name: 'daemon',
    path: getDaemonRepoPath
  },
  {
    name: 'ui',
    path: getUiRepoPath
  }
];
const TRUNK_BRANCH = Deno.env.get('TURBOPANEL_TRUNK_BRANCH')?.trim() || 'trunk';
const INSTANCE_SERVICE = Deno.env.get('TURBOPANEL_INSTANCE_SERVICE')?.trim();
const TURBOPANEL_USER = Deno.env.get('TURBOPANEL_USER')?.trim() || 'turbopanel';
const NORMALIZE_CHECKOUT = '/usr/local/bin/turbopanel-normalize-dev-checkout';
let upgrading = false;
/** Run git as turbopanel (9999) so the deploy key stays mode 0600 and checkouts stay editable. */ async function git(repoRoot, args) {
  try {
    const command = new Deno.Command('sudo', {
      args: [
        '-u',
        TURBOPANEL_USER,
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
/** After git reset, re-home any instance-owned source files back to turbopanel (9999). */ async function normalizeCheckout(repoRoot) {
  try {
    const out = await new Deno.Command('sudo', {
      args: [
        NORMALIZE_CHECKOUT,
        repoRoot
      ],
      stdout: 'piped',
      stderr: 'piped'
    }).output();
    if (out.success) return {
      ok: true
    };
    return {
      ok: false,
      error: new TextDecoder().decode(out.stderr).trim() || 'normalize checkout failed'
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message
    };
  }
}
async function repoDirty(repoRoot) {
  const status = await git(repoRoot, [
    'status',
    '--porcelain'
  ]);
  if (!status.success) {
    return {
      ok: false,
      error: status.stderr || 'git status failed'
    };
  }
  const lines = status.stdout ? status.stdout.split('\n').filter(Boolean) : [];
  return {
    ok: true,
    dirty: lines.length > 0,
    changes: lines.length
  };
}
async function collectDirtyRepos() {
  const dirty = [];
  for (const repo of PLATFORM_REPOS){
    const path = typeof repo.path === 'function' ? repo.path() : repo.path;
    const result = await repoDirty(path);
    if (!result.ok) {
      return {
        ok: false,
        error: `${repo.name}: ${result.error}`
      };
    }
    if (result.dirty) {
      dirty.push({
        repo: repo.name,
        path,
        changes: result.changes
      });
    }
  }
  return {
    ok: true,
    dirty
  };
}
function dirtyUpgradeError(dirty) {
  const names = dirty.map((entry)=>entry.repo).join(', ');
  return `cannot upgrade: uncommitted changes in ${names} (commit or stash first)`;
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
  const normalized = await normalizeCheckout(repoRoot);
  if (!normalized.ok) {
    return {
      ok: false,
      error: `${label} checkout permission fix failed: ${normalized.error}`
    };
  }
  return {
    ok: true
  };
}
export function registerSystemRoutes(app, opts) {
  app.use(`${DEVELOPER_API_PREFIX}/system/*`, createRootOnlyMiddleware(opts.sessionSecret));
  app.get(`${DEVELOPER_API_PREFIX}/system/upgrade-status`, async (c)=>{
    const result = await collectDirtyRepos();
    if (!result.ok) {
      return c.json({
        ok: false,
        error: result.error
      }, 500);
    }
    const body = {
      ok: true,
      canUpgrade: result.dirty.length === 0,
      dirty: result.dirty
    };
    return c.json(body);
  });
  app.post(`${DEVELOPER_API_PREFIX}/system/upgrade`, async (c)=>{
    if (upgrading) {
      return c.json({
        ok: false,
        error: 'upgrade already in progress'
      }, 409);
    }
    const dirtyCheck = await collectDirtyRepos();
    if (!dirtyCheck.ok) {
      return c.json({
        ok: false,
        error: dirtyCheck.error
      }, 500);
    }
    if (dirtyCheck.dirty.length > 0) {
      return c.json({
        ok: false,
        error: dirtyUpgradeError(dirtyCheck.dirty),
        dirty: dirtyCheck.dirty
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
      const instanceSync = await syncRepoToTrunk(INSTANCE_REPO_ROOT, 'instance');
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
      const commit = instanceVersion.commit;
      // Queue restart without awaiting — awaiting systemctl restart kills this
      // process before the HTTP response reaches Caddy (client sees HTTP 502).
      new Deno.Command('sudo', {
        args: [
          'systemctl',
          'restart',
          INSTANCE_SERVICE
        ],
        stdin: 'null',
        stdout: 'null',
        stderr: 'null'
      }).spawn();
      return c.json({
        ok: true,
        commit
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vb3B0L3R1cmJvcGFuZWwvcGxhdGZvcm0vdHVyYm9wYW5lbC9zcmMvc3lzdGVtLXJvdXRlcy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBIb25vIH0gZnJvbSAnaG9ubydcbmltcG9ydCB7IGNyZWF0ZVJvb3RPbmx5TWlkZGxld2FyZSB9IGZyb20gJy4vYXV0aC9taWRkbGV3YXJlLnRzJ1xuaW1wb3J0IHsgZ2V0RGFlbW9uUmVwb1BhdGgsIGdldEluc3RhbmNlQ29tbWl0IH0gZnJvbSAnLi9kYWVtb24tdmVyc2lvbi50cydcbmltcG9ydCB7IGRpcm5hbWUsIGZyb21GaWxlVXJsLCBqb2luIH0gZnJvbSAnanNyOkBzdGQvcGF0aEAxJ1xuaW1wb3J0IHsgREVWRUxPUEVSX0FQSV9QUkVGSVggfSBmcm9tICcuL3N1cmZhY2VzLnRzJ1xuXG5jb25zdCBJTlNUQU5DRV9SRVBPX1JPT1QgPSAoKCkgPT4ge1xuICBjb25zdCBoZXJlID0gZGlybmFtZShmcm9tRmlsZVVybChpbXBvcnQubWV0YS51cmwpKVxuICByZXR1cm4gam9pbihoZXJlLCAnLi4nKVxufSkoKVxuXG5mdW5jdGlvbiBnZXRVaVJlcG9QYXRoKCk6IHN0cmluZyB7XG4gIGNvbnN0IG92ZXJyaWRlID0gRGVuby5lbnYuZ2V0KCdUVVJCT1BBTkVMX1VJX1JFUE8nKT8udHJpbSgpXG4gIGlmIChvdmVycmlkZSkgcmV0dXJuIG92ZXJyaWRlXG4gIHJldHVybiBqb2luKElOU1RBTkNFX1JFUE9fUk9PVCwgJy4uJywgJ3VpJylcbn1cblxuLyoqIFBsYXRmb3JtIGNoZWNrb3V0cyBVcGdyYWRlIFN5c3RlbSBtYXkgcmVzZXQg4oCUIGFsbCBtdXN0IGJlIGNsZWFuIGZpcnN0LiAqL1xuY29uc3QgUExBVEZPUk1fUkVQT1MgPSBbXG4gIHsgbmFtZTogJ2luc3RhbmNlJywgcGF0aDogSU5TVEFOQ0VfUkVQT19ST09UIH0sXG4gIHsgbmFtZTogJ2RhZW1vbicsIHBhdGg6IGdldERhZW1vblJlcG9QYXRoIH0sXG4gIHsgbmFtZTogJ3VpJywgcGF0aDogZ2V0VWlSZXBvUGF0aCB9LFxuXSBhcyBjb25zdFxuXG5leHBvcnQgdHlwZSBEaXJ0eVJlcG8gPSB7XG4gIHJlcG86IHN0cmluZ1xuICBwYXRoOiBzdHJpbmdcbiAgY2hhbmdlczogbnVtYmVyXG59XG5cbmV4cG9ydCB0eXBlIFVwZ3JhZGVTdGF0dXMgPSB7XG4gIG9rOiB0cnVlXG4gIGNhblVwZ3JhZGU6IGJvb2xlYW5cbiAgZGlydHk6IERpcnR5UmVwb1tdXG59XG5cbmNvbnN0IFRSVU5LX0JSQU5DSCA9IERlbm8uZW52LmdldCgnVFVSQk9QQU5FTF9UUlVOS19CUkFOQ0gnKT8udHJpbSgpIHx8ICd0cnVuaydcbmNvbnN0IElOU1RBTkNFX1NFUlZJQ0UgPSBEZW5vLmVudi5nZXQoJ1RVUkJPUEFORUxfSU5TVEFOQ0VfU0VSVklDRScpPy50cmltKClcbmNvbnN0IFRVUkJPUEFORUxfVVNFUiA9IERlbm8uZW52LmdldCgnVFVSQk9QQU5FTF9VU0VSJyk/LnRyaW0oKSB8fCAndHVyYm9wYW5lbCdcbmNvbnN0IE5PUk1BTElaRV9DSEVDS09VVCA9ICcvdXNyL2xvY2FsL2Jpbi90dXJib3BhbmVsLW5vcm1hbGl6ZS1kZXYtY2hlY2tvdXQnXG5cbmxldCB1cGdyYWRpbmcgPSBmYWxzZVxuXG4vKiogUnVuIGdpdCBhcyB0dXJib3BhbmVsICg5OTk5KSBzbyB0aGUgZGVwbG95IGtleSBzdGF5cyBtb2RlIDA2MDAgYW5kIGNoZWNrb3V0cyBzdGF5IGVkaXRhYmxlLiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2l0KFxuICByZXBvUm9vdDogc3RyaW5nLFxuICBhcmdzOiBzdHJpbmdbXSxcbik6IFByb21pc2U8eyBzdWNjZXNzOiBib29sZWFuOyBzdGRvdXQ6IHN0cmluZzsgc3RkZXJyOiBzdHJpbmcgfT4ge1xuICB0cnkge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgRGVuby5Db21tYW5kKCdzdWRvJywge1xuICAgICAgYXJnczogWyctdScsIFRVUkJPUEFORUxfVVNFUiwgJ2dpdCcsICctQycsIHJlcG9Sb290LCAuLi5hcmdzXSxcbiAgICAgIHN0ZG91dDogJ3BpcGVkJyxcbiAgICAgIHN0ZGVycjogJ3BpcGVkJyxcbiAgICB9KVxuICAgIGNvbnN0IG91dCA9IGF3YWl0IGNvbW1hbmQub3V0cHV0KClcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKClcbiAgICByZXR1cm4ge1xuICAgICAgc3VjY2Vzczogb3V0LnN1Y2Nlc3MsXG4gICAgICBzdGRvdXQ6IGRlY29kZXIuZGVjb2RlKG91dC5zdGRvdXQpLnRyaW0oKSxcbiAgICAgIHN0ZGVycjogZGVjb2Rlci5kZWNvZGUob3V0LnN0ZGVycikudHJpbSgpLFxuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBzdGRvdXQ6ICcnLCBzdGRlcnI6IG1lc3NhZ2UgfVxuICB9XG59XG5cbi8qKiBBZnRlciBnaXQgcmVzZXQsIHJlLWhvbWUgYW55IGluc3RhbmNlLW93bmVkIHNvdXJjZSBmaWxlcyBiYWNrIHRvIHR1cmJvcGFuZWwgKDk5OTkpLiAqL1xuYXN5bmMgZnVuY3Rpb24gbm9ybWFsaXplQ2hlY2tvdXQoXG4gIHJlcG9Sb290OiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgb2s6IHRydWUgfSB8IHsgb2s6IGZhbHNlOyBlcnJvcjogc3RyaW5nIH0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBvdXQgPSBhd2FpdCBuZXcgRGVuby5Db21tYW5kKCdzdWRvJywge1xuICAgICAgYXJnczogW05PUk1BTElaRV9DSEVDS09VVCwgcmVwb1Jvb3RdLFxuICAgICAgc3Rkb3V0OiAncGlwZWQnLFxuICAgICAgc3RkZXJyOiAncGlwZWQnLFxuICAgIH0pLm91dHB1dCgpXG4gICAgaWYgKG91dC5zdWNjZXNzKSByZXR1cm4geyBvazogdHJ1ZSB9XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUob3V0LnN0ZGVycikudHJpbSgpIHx8ICdub3JtYWxpemUgY2hlY2tvdXQgZmFpbGVkJyxcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycilcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBtZXNzYWdlIH1cbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiByZXBvRGlydHkoXG4gIHJlcG9Sb290OiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgb2s6IHRydWU7IGRpcnR5OiBib29sZWFuOyBjaGFuZ2VzOiBudW1iZXIgfSB8IHsgb2s6IGZhbHNlOyBlcnJvcjogc3RyaW5nIH0+IHtcbiAgY29uc3Qgc3RhdHVzID0gYXdhaXQgZ2l0KHJlcG9Sb290LCBbJ3N0YXR1cycsICctLXBvcmNlbGFpbiddKVxuICBpZiAoIXN0YXR1cy5zdWNjZXNzKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBzdGF0dXMuc3RkZXJyIHx8ICdnaXQgc3RhdHVzIGZhaWxlZCcsXG4gICAgfVxuICB9XG4gIGNvbnN0IGxpbmVzID0gc3RhdHVzLnN0ZG91dCA/IHN0YXR1cy5zdGRvdXQuc3BsaXQoJ1xcbicpLmZpbHRlcihCb29sZWFuKSA6IFtdXG4gIHJldHVybiB7IG9rOiB0cnVlLCBkaXJ0eTogbGluZXMubGVuZ3RoID4gMCwgY2hhbmdlczogbGluZXMubGVuZ3RoIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY29sbGVjdERpcnR5UmVwb3MoKTogUHJvbWlzZTxcbiAgeyBvazogdHJ1ZTsgZGlydHk6IERpcnR5UmVwb1tdIH0gfCB7IG9rOiBmYWxzZTsgZXJyb3I6IHN0cmluZyB9XG4+IHtcbiAgY29uc3QgZGlydHk6IERpcnR5UmVwb1tdID0gW11cbiAgZm9yIChjb25zdCByZXBvIG9mIFBMQVRGT1JNX1JFUE9TKSB7XG4gICAgY29uc3QgcGF0aCA9IHR5cGVvZiByZXBvLnBhdGggPT09ICdmdW5jdGlvbicgPyByZXBvLnBhdGgoKSA6IHJlcG8ucGF0aFxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcG9EaXJ0eShwYXRoKVxuICAgIGlmICghcmVzdWx0Lm9rKSB7XG4gICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBgJHtyZXBvLm5hbWV9OiAke3Jlc3VsdC5lcnJvcn1gIH1cbiAgICB9XG4gICAgaWYgKHJlc3VsdC5kaXJ0eSkge1xuICAgICAgZGlydHkucHVzaCh7IHJlcG86IHJlcG8ubmFtZSwgcGF0aCwgY2hhbmdlczogcmVzdWx0LmNoYW5nZXMgfSlcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIGRpcnR5IH1cbn1cblxuZnVuY3Rpb24gZGlydHlVcGdyYWRlRXJyb3IoZGlydHk6IERpcnR5UmVwb1tdKTogc3RyaW5nIHtcbiAgY29uc3QgbmFtZXMgPSBkaXJ0eS5tYXAoKGVudHJ5KSA9PiBlbnRyeS5yZXBvKS5qb2luKCcsICcpXG4gIHJldHVybiBgY2Fubm90IHVwZ3JhZGU6IHVuY29tbWl0dGVkIGNoYW5nZXMgaW4gJHtuYW1lc30gKGNvbW1pdCBvciBzdGFzaCBmaXJzdClgXG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN5bmNSZXBvVG9UcnVuayhcbiAgcmVwb1Jvb3Q6IHN0cmluZyxcbiAgbGFiZWw6IHN0cmluZyxcbik6IFByb21pc2U8eyBvazogdHJ1ZSB9IHwgeyBvazogZmFsc2U7IGVycm9yOiBzdHJpbmcgfT4ge1xuICBjb25zdCBmZXRjaGVkID0gYXdhaXQgZ2l0KHJlcG9Sb290LCBbJ2ZldGNoJywgJ29yaWdpbicsIFRSVU5LX0JSQU5DSF0pXG4gIGlmICghZmV0Y2hlZC5zdWNjZXNzKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBgJHtsYWJlbH0gZ2l0IGZldGNoIGZhaWxlZDogJHtmZXRjaGVkLnN0ZGVycn1gLFxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHJlc2V0ID0gYXdhaXQgZ2l0KHJlcG9Sb290LCBbJ3Jlc2V0JywgJy0taGFyZCcsIGBvcmlnaW4vJHtUUlVOS19CUkFOQ0h9YF0pXG4gIGlmICghcmVzZXQuc3VjY2Vzcykge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogYCR7bGFiZWx9IGdpdCByZXNldCBmYWlsZWQ6ICR7cmVzZXQuc3RkZXJyfWAsXG4gICAgfVxuICB9XG5cbiAgY29uc3Qgbm9ybWFsaXplZCA9IGF3YWl0IG5vcm1hbGl6ZUNoZWNrb3V0KHJlcG9Sb290KVxuICBpZiAoIW5vcm1hbGl6ZWQub2spIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGAke2xhYmVsfSBjaGVja291dCBwZXJtaXNzaW9uIGZpeCBmYWlsZWQ6ICR7bm9ybWFsaXplZC5lcnJvcn1gLFxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IG9rOiB0cnVlIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyU3lzdGVtUm91dGVzKFxuICBhcHA6IEhvbm8sXG4gIG9wdHM6IHsgc2Vzc2lvblNlY3JldDogc3RyaW5nIH0sXG4pOiBIb25vIHtcbiAgYXBwLnVzZShgJHtERVZFTE9QRVJfQVBJX1BSRUZJWH0vc3lzdGVtLypgLCBjcmVhdGVSb290T25seU1pZGRsZXdhcmUob3B0cy5zZXNzaW9uU2VjcmV0KSlcblxuICBhcHAuZ2V0KGAke0RFVkVMT1BFUl9BUElfUFJFRklYfS9zeXN0ZW0vdXBncmFkZS1zdGF0dXNgLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNvbGxlY3REaXJ0eVJlcG9zKClcbiAgICBpZiAoIXJlc3VsdC5vaykge1xuICAgICAgcmV0dXJuIGMuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IHJlc3VsdC5lcnJvciB9LCA1MDApXG4gICAgfVxuICAgIGNvbnN0IGJvZHk6IFVwZ3JhZGVTdGF0dXMgPSB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIGNhblVwZ3JhZGU6IHJlc3VsdC5kaXJ0eS5sZW5ndGggPT09IDAsXG4gICAgICBkaXJ0eTogcmVzdWx0LmRpcnR5LFxuICAgIH1cbiAgICByZXR1cm4gYy5qc29uKGJvZHkpXG4gIH0pXG5cbiAgYXBwLnBvc3QoYCR7REVWRUxPUEVSX0FQSV9QUkVGSVh9L3N5c3RlbS91cGdyYWRlYCwgYXN5bmMgKGMpID0+IHtcbiAgICBpZiAodXBncmFkaW5nKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogJ3VwZ3JhZGUgYWxyZWFkeSBpbiBwcm9ncmVzcycgfSwgNDA5KVxuICAgIH1cblxuICAgIGNvbnN0IGRpcnR5Q2hlY2sgPSBhd2FpdCBjb2xsZWN0RGlydHlSZXBvcygpXG4gICAgaWYgKCFkaXJ0eUNoZWNrLm9rKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogZGlydHlDaGVjay5lcnJvciB9LCA1MDApXG4gICAgfVxuICAgIGlmIChkaXJ0eUNoZWNrLmRpcnR5Lmxlbmd0aCA+IDApIHtcbiAgICAgIHJldHVybiBjLmpzb24oXG4gICAgICAgIHtcbiAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgZXJyb3I6IGRpcnR5VXBncmFkZUVycm9yKGRpcnR5Q2hlY2suZGlydHkpLFxuICAgICAgICAgIGRpcnR5OiBkaXJ0eUNoZWNrLmRpcnR5LFxuICAgICAgICB9LFxuICAgICAgICA0MDksXG4gICAgICApXG4gICAgfVxuXG4gICAgaWYgKCFJTlNUQU5DRV9TRVJWSUNFKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7XG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIGVycm9yOlxuICAgICAgICAgICAgJ2luc3RhbmNlIHVwZ3JhZGUgcmVzdGFydCB1bmF2YWlsYWJsZTogVFVSQk9QQU5FTF9JTlNUQU5DRV9TRVJWSUNFIGlzIG5vdCBzZXQgKHJ1biB1bmRlciBzeXN0ZW1kIG9yIGNvbmZpZ3VyZSBhIG1hbmFnZWQgc2VydmljZSknLFxuICAgICAgICB9LFxuICAgICAgICA1MDMsXG4gICAgICApXG4gICAgfVxuXG4gICAgdXBncmFkaW5nID0gdHJ1ZVxuICAgIHRyeSB7XG4gICAgICBjb25zdCBpbnN0YW5jZVN5bmMgPSBhd2FpdCBzeW5jUmVwb1RvVHJ1bmsoSU5TVEFOQ0VfUkVQT19ST09ULCAnaW5zdGFuY2UnKVxuICAgICAgaWYgKCFpbnN0YW5jZVN5bmMub2spIHtcbiAgICAgICAgcmV0dXJuIGMuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IGluc3RhbmNlU3luYy5lcnJvciB9LCA1MDApXG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGRhZW1vblN5bmMgPSBhd2FpdCBzeW5jUmVwb1RvVHJ1bmsoZ2V0RGFlbW9uUmVwb1BhdGgoKSwgJ2RhZW1vbicpXG4gICAgICBpZiAoIWRhZW1vblN5bmMub2spIHtcbiAgICAgICAgcmV0dXJuIGMuanNvbih7IG9rOiBmYWxzZSwgZXJyb3I6IGRhZW1vblN5bmMuZXJyb3IgfSwgNTAwKVxuICAgICAgfVxuXG4gICAgICBjb25zdCBpbnN0YW5jZVZlcnNpb24gPSBhd2FpdCBnZXRJbnN0YW5jZUNvbW1pdCgpXG4gICAgICBjb25zdCBjb21taXQgPSBpbnN0YW5jZVZlcnNpb24uY29tbWl0XG5cbiAgICAgIC8vIFF1ZXVlIHJlc3RhcnQgd2l0aG91dCBhd2FpdGluZyDigJQgYXdhaXRpbmcgc3lzdGVtY3RsIHJlc3RhcnQga2lsbHMgdGhpc1xuICAgICAgLy8gcHJvY2VzcyBiZWZvcmUgdGhlIEhUVFAgcmVzcG9uc2UgcmVhY2hlcyBDYWRkeSAoY2xpZW50IHNlZXMgSFRUUCA1MDIpLlxuICAgICAgbmV3IERlbm8uQ29tbWFuZCgnc3VkbycsIHtcbiAgICAgICAgYXJnczogWydzeXN0ZW1jdGwnLCAncmVzdGFydCcsIElOU1RBTkNFX1NFUlZJQ0VdLFxuICAgICAgICBzdGRpbjogJ251bGwnLFxuICAgICAgICBzdGRvdXQ6ICdudWxsJyxcbiAgICAgICAgc3RkZXJyOiAnbnVsbCcsXG4gICAgICB9KS5zcGF3bigpXG5cbiAgICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSwgY29tbWl0IH0pXG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICByZXR1cm4gYy5qc29uKHsgb2s6IGZhbHNlLCBlcnJvcjogbWVzc2FnZSB9LCA1MDApXG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHVwZ3JhZGluZyA9IGZhbHNlXG4gICAgfVxuICB9KVxuXG4gIHJldHVybiBhcHBcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFDQSxTQUFTLHdCQUF3QixRQUFRLHVCQUFzQjtBQUMvRCxTQUFTLGlCQUFpQixFQUFFLGlCQUFpQixRQUFRLHNCQUFxQjtBQUMxRSxTQUFTLE9BQU8sRUFBRSxXQUFXLEVBQUUsSUFBSSxRQUFRLGtCQUFpQjtBQUM1RCxTQUFTLG9CQUFvQixRQUFRLGdCQUFlO0FBRXBELE1BQU0scUJBQXFCLENBQUM7RUFDMUIsTUFBTSxPQUFPLFFBQVEsWUFBWSxZQUFZLEdBQUc7RUFDaEQsT0FBTyxLQUFLLE1BQU07QUFDcEIsQ0FBQztBQUVELFNBQVM7RUFDUCxNQUFNLFdBQVcsS0FBSyxHQUFHLENBQUMsR0FBRyxDQUFDLHVCQUF1QjtFQUNyRCxJQUFJLFVBQVUsT0FBTztFQUNyQixPQUFPLEtBQUssb0JBQW9CLE1BQU07QUFDeEM7QUFFQSwyRUFBMkUsR0FDM0UsTUFBTSxpQkFBaUI7RUFDckI7SUFBRSxNQUFNO0lBQVksTUFBTTtFQUFtQjtFQUM3QztJQUFFLE1BQU07SUFBVSxNQUFNO0VBQWtCO0VBQzFDO0lBQUUsTUFBTTtJQUFNLE1BQU07RUFBYztDQUNuQztBQWNELE1BQU0sZUFBZSxLQUFLLEdBQUcs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
// denoCacheMetadata=9987360977104945364,3915483973996835652