import { assertEquals } from '@std/assert'
import { issueLeafCertificate, mintOrganizationCa } from '../../lib/tls/self-signed.ts'
import {
  type OpensslCheckIo,
  opensslScratchDir,
  privateUploadedTrustMaterial,
  uploadedCertificateChainsToPublicRoot,
} from './install-trust.ts'

const test = Deno.test.bind(Deno)

const HOST = 'private.example.com'

type FakeIo = OpensslCheckIo & {
  files: Map<string, string>
  removed: string[]
  runs: { args: string[]; stdin: string }[]
  mkdirs: { path: string; mode: number }[]
}

/**
 * In-memory stand-in for the file and process calls. `tempDenied` denies the
 * system temp folder (the compiled binary has no grant for it);
 * `scratchDenied` also denies the instance's own scratch folder.
 */
function fakeIo(opts: {
  tempDenied: boolean
  scratchDenied: boolean
  opensslOk?: boolean
}): FakeIo {
  const files = new Map<string, string>()
  const removed: string[] = []
  const runs: { args: string[]; stdin: string }[] = []
  const mkdirs: { path: string; mode: number }[] = []
  let serial = 0
  return {
    files,
    removed,
    runs,
    mkdirs,
    stateDir: () => '/state/',
    makeTempFile: (options) => {
      if (options.dir === undefined && opts.tempDenied) {
        return Promise.reject(new Deno.errors.NotCapable('Requires write access to "/tmp"'))
      }
      serial += 1
      const path = `${options.dir ?? '/tmp'}/${options.prefix}${serial}${options.suffix}`
      files.set(path, '')
      return Promise.resolve(path)
    },
    mkdir: (path, options) => {
      mkdirs.push({ path, mode: options.mode })
      if (opts.scratchDenied) {
        return Promise.reject(new Deno.errors.PermissionDenied('Permission denied (os error 13)'))
      }
      return Promise.resolve()
    },
    writeTextFile: (path, data) => {
      if (opts.scratchDenied && !path.startsWith('/tmp/')) {
        return Promise.reject(new Deno.errors.PermissionDenied('Permission denied (os error 13)'))
      }
      files.set(path, data)
      return Promise.resolve()
    },
    remove: (path) => {
      removed.push(path)
      files.delete(path)
      return Promise.resolve()
    },
    runOpenssl: (args, stdin) => {
      runs.push({ args, stdin })
      return Promise.resolve(opts.opensslOk ?? false)
    },
  }
}

async function chain() {
  const ca = await mintOrganizationCa({ organizationId: 'install-trust-scratch' })
  const other = await mintOrganizationCa({ organizationId: 'install-trust-other' })
  const leaf = await issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, [HOST])
  return {
    leaf: leaf.certificatePem.trim(),
    issuer: ca.certificatePem.trim(),
    unrelated: other.certificatePem.trim(),
  }
}

test('a denied temp folder and a denied scratch folder are a handled answer, never a throw', async () => {
  const { leaf, unrelated } = await chain()
  const io = fakeIo({ tempDenied: true, scratchDenied: true })
  const pem = `${leaf}\n${unrelated}\n`
  assertEquals(await uploadedCertificateChainsToPublicRoot(pem, io), false)
  // The unrelated block fails the signature check, so the openssl check
  // would need a scratch file; with none writable it reads as no issuer.
  assertEquals(await privateUploadedTrustMaterial(pem, HOST, io), null)
  assertEquals(io.runs, [])
  assertEquals(io.files.size, 0)
})

test('a covering issuer is still found when no scratch file can be written', async () => {
  const { leaf, issuer } = await chain()
  const io = fakeIo({ tempDenied: true, scratchDenied: true })
  assertEquals(await privateUploadedTrustMaterial(`${leaf}\n${issuer}\n`, HOST, io), `${issuer}\n`)
})

test('a lone leaf goes to openssl on standard input with no file at all', async () => {
  const { leaf } = await chain()
  const io = fakeIo({ tempDenied: true, scratchDenied: true, opensslOk: true })
  assertEquals(await uploadedCertificateChainsToPublicRoot(leaf, io), true)
  assertEquals(io.runs, [{ args: ['verify'], stdin: leaf }])
  assertEquals(io.mkdirs, [])
})

test('under production grants the intermediates land in the instance scratch folder and are removed', async () => {
  const { leaf, unrelated } = await chain()
  const io = fakeIo({ tempDenied: true, scratchDenied: false, opensslOk: true })
  assertEquals(await uploadedCertificateChainsToPublicRoot(`${leaf}\n${unrelated}\n`, io), true)
  assertEquals(io.mkdirs, [{ path: '/state/instance/tmp', mode: 0o700 }])
  assertEquals(io.runs.length, 1)
  const [run] = io.runs
  assertEquals(run.stdin, leaf)
  assertEquals(run.args.slice(0, 2), ['verify', '-untrusted'])
  assertEquals(run.args[2].startsWith('/state/instance/tmp/tp-uploaded-trust-'), true)
  assertEquals(io.removed, [run.args[2]])
  assertEquals(io.files.size, 0)
})

test('the openssl issuer check reads the leaf from standard input', async () => {
  const { leaf, unrelated } = await chain()
  const io = fakeIo({ tempDenied: false, scratchDenied: false, opensslOk: false })
  assertEquals(await privateUploadedTrustMaterial(`${leaf}\n${unrelated}\n`, HOST, io), null)
  assertEquals(io.runs.length, 1)
  const [run] = io.runs
  assertEquals(run.stdin, leaf)
  assertEquals(run.args.slice(0, 3), ['verify', '-partial_chain', '-CAfile'])
  assertEquals(io.files.size, 0)
})

test('the scratch folder sits under the instance folder of the state tree', () => {
  assertEquals(opensslScratchDir(undefined), '/var/lib/turbopanel/instance/tmp')
  assertEquals(opensslScratchDir(' /srv/state// '), '/srv/state/instance/tmp')
})
