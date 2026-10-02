/**
 * Host-affecting deploy checks. Each deploys onto the first `--host` (never
 * studio, adrastea or kore) inside a run-owned workspace and tears the
 * environment down (stop, then delete) in cleanup. Native and site services
 * create a Unix principal on the host that environment delete does not remove;
 * the README lists that as a known leftover.
 */
import type { Check, CheckContext, Json } from '../types.ts'
import {
  APP_PRINCIPAL,
  composeProject,
  deploy,
  environmentContainers,
  servedStatus,
  sshNameFor,
  stopEnvironment,
  waitCommand,
  queued,
} from './fixtures.ts'
import { excerpt, expectStatus, fail, listOf, objOf, pass, skip, str, type Rec } from './helpers.ts'

const V1 = '/client/v1'
const NO_HOST = 'needs --host <server> (not studio/adrastea/kore)'

export const REPOS = {
  node: 'https://github.com/heroku/node-js-getting-started.git',
  next: 'https://github.com/privatehosting-xyz/nextjs.git',
  html: 'https://github.com/mdn/beginner-html-site.git',
  dockerfile: 'https://github.com/docker/welcome-to-docker.git',
}

/** Register (or reuse) a public git source; only a row this run created is deleted. */
export async function ensureRepository(ctx: CheckContext, url: string): Promise<string> {
  const res = await ctx.api.post(`${V1}/repositories`, { body: { repositoryUrl: url } })
  expectStatus(res, 'repository')
  const body = objOf(res.body)
  const id = str(body, 'id')
  if (body.reused !== true) {
    ctx.defer(`repository ${url}`, async () => {
      expectStatus(
        await ctx.api.del(`${V1}/repositories/${id}`),
        'delete repository',
        200,
        204,
        404,
        409
      )
    })
  }
  return id
}

function hosting(ctx: CheckContext, label: string, targetPort?: number): Json[] {
  const entry: { [key: string]: Json } = {
    hostname: `${ctx.prefix}-${label}.testing.invalid`,
    forceHttps: false,
  }
  if (targetPort !== undefined) entry.targetPort = targetPort
  return [entry]
}

/** Deploy a one-service project and report deploy + served status. */
async function deployOne(
  ctx: CheckContext,
  label: string,
  service: { [key: string]: Json },
  root?: { [key: string]: Json }
) {
  const project = await composeProject(ctx, label, { [label]: service }, root)
  if (!project) return undefined
  const result = await deploy(ctx, project.environmentId)
  const sshHost = sshNameFor(ctx, project.server)
  const served = sshHost
    ? await servedStatus(ctx, sshHost, `${ctx.prefix}-${label}.testing.invalid`)
    : ''
  return { project, result, served }
}

function servedNote(served: string): string {
  return served
    ? `, hostname via hosting proxy -> ${served}`
    : ' (pass --ssh-host to curl the hostname)'
}

function deployVerdict(label: string, run: NonNullable<Awaited<ReturnType<typeof deployOne>>>) {
  const host = str(run.project.server, 'hostname')
  const evidence = `${label} on ${host}: deploy ${run.result.status}${run.result.error ? ` (${excerpt(run.result.error, 160)})` : ''}${servedNote(run.served)}`
  const servedOk = run.served === '' || run.served === '200'
  return run.result.status === 'succeeded' && servedOk ? pass(evidence) : fail(evidence)
}

export const deployImage: Check = {
  rowId: 'deploy-image',
  title: 'Compose service from an image',
  requires: ['api'],
  safety: 'host-affecting',
  async run(ctx) {
    const project = await composeProject(ctx, 'img', {
      web: { image: 'traefik/whoami', 'x-turbopanel': { hosting: hosting(ctx, 'img', 80) } },
    })
    if (!project) return skip(NO_HOST)
    const first = await deploy(ctx, project.environmentId)
    const second = await deploy(ctx, project.environmentId, { noCache: true })
    const containers = await environmentContainers(ctx, project.environmentId)
    const running = containers.filter((c) => str(c, 'status') === 'running')
    const logs = running[0]
      ? await ctx.api.get(`${V1}/containers/${str(running[0], 'id')}/logs?tail=20`)
      : undefined
    const history = await ctx.api.get(
      `${V1}/environments/${project.environmentId}/deployments?limit=5`
    )
    const evidence = `whoami on ${str(project.server, 'hostname')}: deploy ${first.status}, noCache redeploy ${second.status}, ${running.length} running, logs ${logs?.status ?? 'n/a'}, history ${listOf(history.body, 'deployments').length} entries`
    const ok = first.status === 'succeeded' && second.status === 'succeeded' && running.length > 0
    return ok && logs?.status === 200 ? pass(evidence) : fail(evidence)
  },
}

export const deployPorts: Check = {
  rowId: 'deploy-ports',
  title: 'Publish a raw TCP port',
  requires: ['api'],
  safety: 'host-affecting',
  async run(ctx) {
    const port = 18100 + Math.floor(Math.random() * 800)
    const project = await composeProject(ctx, 'port', {
      web: { image: 'traefik/whoami', ports: [`${port}:80`] },
    })
    if (!project) return skip(NO_HOST)
    const address = str(project.server, 'address')
    const result = await deploy(ctx, project.environmentId)
    const open = await ctx.probe(`http://${hostForUrl(address)}:${port}/`)
    await stopEnvironment(ctx, project.environmentId)
    const closed = await ctx.probe(`http://${hostForUrl(address)}:${port}/`)
    const evidence = `port ${port} on ${str(project.server, 'hostname')} (${address}): deploy ${result.status}, from runner HTTP ${open} while running, ${closed || 'no answer'} after stop`
    return result.status === 'succeeded' && open === 200 && closed !== 200
      ? pass(evidence)
      : fail(evidence)
  },
}

function hostForUrl(address: string): string {
  return address.includes(':') ? `[${address}]` : address
}

function nodeService(
  ctx: CheckContext,
  label: string,
  source: { [key: string]: Json },
  extra = {}
) {
  return {
    'x-turbopanel': {
      serviceKind: 'node',
      principal: 'app',
      source,
      hosting: hosting(ctx, label),
      ...extra,
    },
  }
}

export const deployNativeNode: Check = {
  rowId: 'deploy-native-node',
  title: 'Native Node app (host-run)',
  requires: ['api'],
  safety: 'host-affecting',
  async run(ctx) {
    if (ctx.hosts.length === 0) return skip(NO_HOST)
    const sourceId = await ensureRepository(ctx, REPOS.node)
    const run = await deployOne(
      ctx,
      'node',
      nodeService(ctx, 'node', { sourceId }, { startupFile: 'index.js' }),
      APP_PRINCIPAL
    )
    return run ? deployVerdict('node app', run) : skip(NO_HOST)
  },
}

export const deployNativeNext: Check = {
  rowId: 'deploy-native-next',
  title: 'Native Next.js app',
  requires: ['api'],
  safety: 'host-affecting',
  async run(ctx) {
    if (ctx.hosts.length === 0) return skip(NO_HOST)
    const sourceId = await ensureRepository(ctx, REPOS.next)
    const source = { sourceId, buildCommand: 'pnpm run build', startCommand: 'pnpm start' }
    const run = await deployOne(ctx, 'next', nodeService(ctx, 'next', source), APP_PRINCIPAL)
    return run ? deployVerdict('Next.js app', run) : skip(NO_HOST)
  },
}

function siteService(ctx: CheckContext, label: string, engine: string, content: Rec, php: boolean) {
  const ext: { [key: string]: Json } = {
    serviceKind: 'site',
    engine,
    principal: 'app',
    hosting: hosting(ctx, label),
    ...content,
  }
  if (php) ext.php = {}
  return { 'x-turbopanel': ext }
}

function siteCheck(
  rowId: string,
  title: string,
  engine: string,
  php: boolean,
  managedDir: boolean
): Check {
  const label = rowId.replace('deploy-', '').replaceAll('-', '')
  return {
    rowId,
    title,
    requires: ['api'],
    safety: 'host-affecting',
    async run(ctx) {
      if (ctx.hosts.length === 0) return skip(NO_HOST)
      const content: Rec = managedDir
        ? { sourceKind: 'managed-directory' }
        : { source: { sourceId: await ensureRepository(ctx, REPOS.html) }, root: '.' }
      const run = await deployOne(
        ctx,
        label,
        siteService(ctx, label, engine, content, php),
        APP_PRINCIPAL
      )
      return run ? deployVerdict(`${engine}${php ? '+php' : ''} site`, run) : skip(NO_HOST)
    },
  }
}

export const deploySiteNginx = siteCheck(
  'deploy-site-nginx',
  'Static site on nginx',
  'nginx',
  false,
  false
)
export const deploySiteNginxPhp = siteCheck(
  'deploy-site-nginx-php',
  'nginx + PHP-FPM site',
  'nginx',
  true,
  true
)
export const deploySiteApache = siteCheck(
  'deploy-site-apache',
  'Apache + PHP-FPM site',
  'apache',
  true,
  true
)
export const deployManagedDir = siteCheck(
  'deploy-managed-dir',
  'Managed-directory site',
  'caddy',
  false,
  true
)

export const deploySourceRelease: Check = {
  rowId: 'deploy-source-release',
  title: 'Git-backed source release: promote and roll back',
  requires: ['api'],
  safety: 'host-affecting',
  async run(ctx) {
    if (ctx.hosts.length === 0) return skip(NO_HOST)
    const sourceId = await ensureRepository(ctx, REPOS.node)
    const service = nodeService(ctx, 'rel', { sourceId }, { startupFile: 'index.js' })
    const project = await composeProject(ctx, 'rel', { rel: service }, APP_PRINCIPAL)
    if (!project) return skip(NO_HOST)
    const first = await deploy(ctx, project.environmentId)
    const second = await deploy(ctx, project.environmentId, { noCache: true })
    const releases = await listReleases(ctx, project.environmentId)
    const target = releases.find((r) => r.isLive !== true && str(r, 'status') === 'succeeded')
    const base = `deploys ${first.status}/${second.status}, ${releases.length} releases`
    if (!target) return fail(`${base}; no earlier succeeded release to roll back to`)
    const rb = await ctx.api.post(`${V1}/environments/${project.environmentId}/rollback`, {
      body: { composeServiceName: 'rel', releaseId: str(target, 'releaseId') },
    })
    const q = queued(rb.body)
    const done = q.commandId
      ? await waitCommand(ctx, q.serverId, q.commandId)
      : { status: `HTTP ${rb.status}`, record: {} }
    const live = (await listReleases(ctx, project.environmentId)).find((r) => r.isLive === true)
    const flipped = str(live, 'releaseId') === str(target, 'releaseId')
    const evidence = `${base}; rollback ${done.status}${str(done.record, 'errorMessage') ? ` (${excerpt(str(done.record, 'errorMessage'), 120)})` : ''}, live release is the earlier one: ${flipped}`
    return done.status === 'succeeded' && flipped ? pass(evidence) : fail(evidence)
  },
}

async function listReleases(ctx: CheckContext, environmentId: string): Promise<Rec[]> {
  const res = await ctx.api.get(
    `${V1}/environments/${environmentId}/releases?composeServiceName=rel&limit=10`
  )
  return listOf(res.body, 'releases')
}

/**
 * Compose `build:` from a git context (docker/welcome-to-docker, port 3000).
 * The body mirrors the earlier manual proof on kore; a second deploy without
 * noCache must reuse the built image.
 */
export const deployDockerfile: Check = {
  rowId: 'deploy-dockerfile',
  title: 'Compose service built from a Dockerfile in the repo',
  requires: ['api'],
  safety: 'host-affecting',
  async run(ctx) {
    const project = await composeProject(ctx, 'dkf', {
      web: {
        build: { context: REPOS.dockerfile },
        'x-turbopanel': { hosting: hosting(ctx, 'dkf', 3000) },
      },
    })
    if (!project) return skip(NO_HOST)
    const first = await deploy(ctx, project.environmentId)
    const log = await commandLog(ctx, first.serverId, first.commandId)
    const second = await deploy(ctx, project.environmentId)
    const reuse = await commandLog(ctx, second.serverId, second.commandId)
    const built = /build|Step|#\d+ /i.test(log)
    const reused = reuse.length > 0 && (/CACHED|Using cache/i.test(reuse) || !/#\d+ \[/.test(reuse))
    const evidence = `git-context build on ${str(project.server, 'hostname')}: deploy ${first.status}${first.error ? ` (${excerpt(first.error, 120)})` : ''}, build log seen: ${built}; redeploy ${second.status}, image reused: ${reused}`
    return first.status === 'succeeded' && second.status === 'succeeded' && built && reused
      ? pass(evidence)
      : fail(evidence)
  },
}

/** The streamed command log (first page is enough to see build steps). */
async function commandLog(ctx: CheckContext, serverId: string, commandId: string): Promise<string> {
  if (!serverId || !commandId) return ''
  const res = await ctx.api.get(`${V1}/servers/${serverId}/commands/${commandId}/log?from=0`)
  return str(objOf(res.body), 'text')
}

export const DEPLOY_CHECKS: readonly Check[] = [
  deployImage,
  deployPorts,
  deployDockerfile,
  deployNativeNode,
  deployNativeNext,
  deploySiteNginx,
  deploySiteNginxPhp,
  deploySiteApache,
  deployManagedDir,
  deploySourceRelease,
]
