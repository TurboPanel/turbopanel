/**
 * Creates-objects checks: they add panel rows (workspaces, projects,
 * environments, certificates, users) and delete what they added. Nothing here
 * deploys, so no host is touched.
 */
import type { Check, CheckContext } from '../types.ts'
import { createProject, createWorkspace } from './fixtures.ts'
import {
  dig,
  excerpt,
  expectStatus,
  fail,
  listOf,
  objOf,
  pass,
  sequential,
  skip,
  str,
} from './helpers.ts'

const V1 = '/client/v1'

/** Self-signed cert + key, generated locally per run and held in memory only. */
export async function mintCertificate(cn: string): Promise<{ cert: string; key: string }> {
  const args = ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256']
  args.push('-nodes', '-days', '2', '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`)
  args.push('-keyout', '/dev/stdout', '-out', '/dev/stdout')
  const out = await new Deno.Command('openssl', { args, stdout: 'piped', stderr: 'null' }).output()
  if (out.code !== 0) throw new Error(`openssl exited ${out.code}`)
  const text = new TextDecoder().decode(out.stdout)
  const cert = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(text)?.[0]
  const key = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/.exec(
    text
  )?.[0]
  if (!cert || !key) throw new Error('openssl output had no certificate/key')
  return { cert: `${cert}\n`, key: `${key}\n` }
}

async function deleteTls(ctx: CheckContext, id: string): Promise<void> {
  expectStatus(await ctx.api.del(`${V1}/tls/${id}`), 'delete tls', 200, 204, 404)
}

export const hostingUploadCert: Check = {
  rowId: 'hosting-upload-cert',
  title: 'Upload a certificate',
  requires: ['api'],
  safety: 'creates-objects',
  async run(ctx) {
    const name = `${ctx.prefix}-upload`
    const good = await mintCertificate(`${name}.testing.invalid`)
    const other = await mintCertificate(`${name}-other.testing.invalid`)
    const mismatch = await ctx.api.post(`${V1}/tls`, {
      body: {
        source: 'upload',
        name: `${name}-bad`,
        certificatePem: good.cert,
        privateKeyPem: other.key,
      },
    })
    if (mismatch.status < 300) {
      ctx.defer('mismatched tls', () => deleteTls(ctx, str(objOf(mismatch.body), 'id')))
    }
    const res = await ctx.api.post(`${V1}/tls`, {
      body: { source: 'upload', name, certificatePem: good.cert, privateKeyPem: good.key },
    })
    expectStatus(res, 'upload tls')
    const id = str(objOf(res.body), 'id')
    ctx.defer(`tls ${name}`, () => deleteTls(ctx, id))
    const one = await ctx.api.get(`${V1}/tls/${id}`)
    const list = await ctx.api.get(`${V1}/tls`)
    const leaked = /PRIVATE KEY|privateKeyPem/.test(JSON.stringify([one.body, list.body]))
    const evidence = `upload 2xx id ${id}; GET one ${one.status}, list ${list.status}, key in responses: ${leaked}; mismatched key -> HTTP ${mismatch.status} ${excerpt(mismatch.body, 80)}`
    const rejected = mismatch.status === 400
    return one.status === 200 && !leaked && rejected ? pass(evidence) : fail(evidence)
  },
}

export const hostingSelfSigned: Check = {
  rowId: 'hosting-self-signed',
  title: 'Mint a self-signed certificate',
  requires: ['api'],
  safety: 'creates-objects',
  async run(ctx) {
    const name = `${ctx.prefix}-ss`
    const hostname = `${name}.testing.invalid`
    const res = await ctx.api.post(`${V1}/tls`, {
      body: { source: 'self_signed', name, hostnames: [hostname] },
    })
    expectStatus(res, 'mint self-signed')
    const id = str(objOf(res.body), 'id')
    ctx.defer(`tls ${name}`, () => deleteTls(ctx, id))
    const one = objOf((await ctx.api.get(`${V1}/tls/${id}`)).body, 'tls', 'certificate')
    const meta = objOf(one, 'metadata')
    const names = JSON.stringify(meta.dnsNames ?? [])
    const hasPem = str(one, 'certificatePem').includes('BEGIN CERTIFICATE')
    const evidence = `minted ${id} source=${str(one, 'source')} dnsNames=${names} pem=${hasPem} notAfter=${str(meta, 'notAfter')}`
    return names.includes(hostname) && hasPem ? pass(evidence) : fail(evidence)
  },
}

/** Route-auth probe only: the session must reach the DR route (not a 401). */
export const managedPgDrRoute: Check = {
  rowId: 'managed-pg-dr',
  title: 'Disaster recovery route accepts a session',
  requires: ['api'],
  safety: 'creates-objects',
  async run(ctx) {
    const ghost = crypto.randomUUID()
    const res = await ctx.api.post(
      `${V1}/environments/${ghost}/managed/disaster-recovery/promote`,
      {
        body: { confirm: false, memberId: crypto.randomUUID() },
      }
    )
    const evidence = `POST /environments/<unknown id>/managed/disaster-recovery/promote -> HTTP ${res.status} ${excerpt(res.body, 100)} (route-auth probe on a nonexistent environment; writes nothing; the end-to-end DR runbook is not automated)`
    if (res.status === 401) return fail(evidence)
    return res.status < 500 ? pass(evidence) : fail(evidence)
  },
}

export const projectsCreate: Check = {
  rowId: 'projects-create',
  title: 'Create a project from each catalog template',
  requires: ['api'],
  safety: 'creates-objects',
  async run(ctx) {
    const catalog = listOf((await ctx.api.get(`${V1}/project-catalog`)).body, 'catalog')
    const templates = catalog.filter((c) => str(c, 'kind') === 'template')
    if (templates.length === 0) return skip('catalog lists no templates')
    const workspaceId = await createWorkspace(ctx, 'tpl')
    const notes = await sequential(templates, async (t) => {
      const code = str(t, 'code')
      const ref = await createProject(ctx, {
        workspaceId,
        type: 'template',
        code,
        name: `${ctx.prefix}-${code}`,
      })
      const env = (await ctx.api.get(`${V1}/environments/${ref.environmentId}`)).body
      const composed = Object.keys(
        dig(env, 'environment', 'options', 'compose', 'data', 'services')
      )
      const rows = listOf(
        (await ctx.api.get(`${V1}/services?environmentId=${ref.environmentId}`)).body,
        'services'
      ).map((svc) => str(svc, 'name', 'composeServiceName'))
      const services = composed.length > 0 ? composed : rows
      return {
        ok: services.length > 0,
        note: `${code}: env ${ref.environmentId.slice(0, 8)} services [${services.join(',')}]`,
      }
    })
    const evidence = `${templates.length} templates scaffolded: ${notes.map((n) => n.note).join('; ')}`
    return notes.every((n) => n.ok) ? pass(evidence) : fail(evidence)
  },
}

export const projectsEnvironments: Check = {
  rowId: 'projects-environments',
  title: 'Add, rename, delete environments',
  requires: ['api'],
  safety: 'creates-objects',
  async run(ctx) {
    const workspaceId = await createWorkspace(ctx, 'envs')
    const { projectId } = await createProject(ctx, {
      workspaceId,
      type: 'empty',
      name: `${ctx.prefix}-envs`,
    })
    const created = await ctx.api.post(`${V1}/environments`, {
      body: { projectId, name: `${ctx.prefix}-e2` },
    })
    expectStatus(created, 'create environment')
    const envId = str(objOf(created.body), 'id')
    const renamed = `${ctx.prefix}-e2b`
    const patch = await ctx.api.patch(`${V1}/environments/${envId}`, { body: { name: renamed } })
    const after = objOf((await ctx.api.get(`${V1}/environments/${envId}`)).body, 'environment')
    const del = await ctx.api.del(`${V1}/environments/${envId}`)
    const gone = await ctx.api.get(`${V1}/environments/${envId}`)
    const evidence = `create ${created.status}, rename PATCH ${patch.status} -> name ${str(after, 'name')}, delete ${del.status}, GET after delete ${gone.status}`
    const ok = str(after, 'name') === renamed && del.status < 300 && gone.status === 404
    return ok ? pass(evidence) : fail(evidence)
  },
}

export const OBJECT_CHECKS: readonly Check[] = [
  hostingUploadCert,
  hostingSelfSigned,
  managedPgDrRoute,
  projectsCreate,
  projectsEnvironments,
]
