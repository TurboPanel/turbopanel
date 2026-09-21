import { assertEquals } from '@std/assert'
import { lexDockerRunCommand } from './lexer.ts'
import { parseDockerRunCommand } from './parse.ts'
import { importDockerRunCommand } from './index.ts'
import {
  DOCKER_RUN_OPTIONS,
  dockerRunOptionName,
} from './option-registry.ts'
import { composeDocumentToYaml } from '../compose/convert.ts'
import { blockingComposeLintIssues, lintComposeYaml } from '../compose/lint.ts'
import { validateComposeDocument } from '../compose/validate.ts'

/** See the note in `./option-registry.test.ts`. */
const test = Deno.test.bind(Deno)

function serviceOf(compose: { data: Record<string, unknown> }, name = 'web') {
  const services = compose.data.services as Record<string, unknown>
  return services[name] as Record<string, unknown>
}

test('a pasted command keeps its docker run prefix out of the image', () => {
  const lexed = lexDockerRunCommand('sudo docker container run -d nginx:alpine')
  assertEquals(lexed.tokens, ['-d', 'nginx:alpine'])
})

test('only a complete docker run prefix is stripped', () => {
  assertEquals(
    lexDockerRunCommand('sudo docker run -d nginx').tokens,
    ['-d', 'nginx'],
  )
  assertEquals(
    lexDockerRunCommand('docker container run -d nginx').tokens,
    ['-d', 'nginx'],
  )
  assertEquals(
    lexDockerRunCommand(['docker', 'container', 'run', 'nginx']).tokens,
    ['nginx'],
  )
})

test('an image named like a prefix word is not mistaken for the prefix', () => {
  // The endpoint accepts argv with the `docker run` already removed, so a lone
  // leading `run` / `docker` / `container` / `sudo` is the IMAGE, not a prefix.
  for (const image of ['run', 'docker', 'container', 'sudo']) {
    assertEquals(
      lexDockerRunCommand(`${image} -d`).tokens,
      [image, '-d'],
      image,
    )
    assertEquals(
      lexDockerRunCommand([image, '-d']).tokens,
      [image, '-d'],
      image,
    )

    const fromString = importDockerRunCommand({ serviceName: 'web', argv: image })
    assertEquals(serviceOf(fromString.compose).image, image, image)
    const fromArgv = importDockerRunCommand({ serviceName: 'web', argv: [image] })
    assertEquals(serviceOf(fromArgv.compose).image, image, image)
  }

  // A real prefix in front of it still strips, leaving the image intact.
  const prefixed = importDockerRunCommand({
    serviceName: 'web',
    argv: 'docker run run',
  })
  assertEquals(serviceOf(prefixed.compose).image, 'run')
})

test('quotes hold a value with spaces together', () => {
  const lexed = lexDockerRunCommand(
    `docker run -e "GREETING=hello world" -e 'B=a b' nginx`,
  )
  assertEquals(lexed.tokens, ['-e', 'GREETING=hello world', '-e', 'B=a b', 'nginx'])
})

test('a line-continuation paste from a README lexes as one command', () => {
  const lexed = lexDockerRunCommand(
    'docker run \\\n  -p 8080:80 \\\n  --name web \\\n  nginx:alpine',
  )
  assertEquals(lexed.tokens, [
    '-p',
    '8080:80',
    '--name',
    'web',
    'nginx:alpine',
  ])
})

test('command substitution is taken literally and never evaluated', () => {
  const lexed = lexDockerRunCommand('docker run -e UID=$(id -u) nginx')
  assertEquals(lexed.tokens, ['-e', 'UID=$(id -u)', 'nginx'])
  assertEquals(lexed.warnings[0]?.code, 'command_substitution_literal')
})

test('a shell pipeline is a literal character, not a second command', () => {
  const lexed = lexDockerRunCommand('docker run nginx && rm -rf /')
  assertEquals(lexed.tokens.includes('&&'), true)
  assertEquals(
    lexed.warnings.some((w) => w.code === 'shell_operator_literal'),
    true,
  )
})

test('an argv array is taken as already-split, not re-lexed', () => {
  const lexed = lexDockerRunCommand([
    'docker',
    'run',
    '-e',
    'MSG=a "quoted" value',
    'nginx',
  ])
  assertEquals(lexed.tokens, ['-e', 'MSG=a "quoted" value', 'nginx'])
})

test('clustered shorthands split, and the image survives', () => {
  const parsed = parseDockerRunCommand('docker run -itd --rm nginx:alpine sh -c echo')
  assertEquals(parsed.image, 'nginx:alpine')
  assertEquals(parsed.command, ['sh', '-c', 'echo'])
  assertEquals(parsed.entries.map((entry) => entry.rawFlag), [
    '-i',
    '-t',
    '-d',
    '--rm',
  ])
})

test('an attached shorthand value is read off the same token', () => {
  const parsed = parseDockerRunCommand('docker run -p8080:80 -uroot nginx')
  assertEquals(parsed.image, 'nginx')
  assertEquals(
    parsed.entries.map((entry) => [entry.rawFlag, entry.value]),
    [['-p', '8080:80'], ['-u', 'root']],
  )
})

test('an unknown flag is reported rather than eating the image', () => {
  const parsed = parseDockerRunCommand('docker run --shiny-new-flag nginx:alpine')
  const unknown = parsed.diagnostics.find((d) => d.code === 'unknown_option')
  assertEquals(unknown?.flag, '--shiny-new-flag')
  assertEquals(unknown?.blocking, true)
  // The token after it is still read as the image — the parser never guesses
  // that an unknown flag consumed it.
  assertEquals(parsed.image, 'nginx:alpine')
})

test('flags after the image belong to the container command', () => {
  const parsed = parseDockerRunCommand('docker run nginx nginx -g "daemon off;"')
  assertEquals(parsed.image, 'nginx')
  assertEquals(parsed.command, ['nginx', '-g', 'daemon off;'])
  assertEquals(parsed.entries.length, 0)
})

test('a command with no image is refused, not compiled around', () => {
  const parsed = parseDockerRunCommand('docker run -d -p 80:80')
  assertEquals(parsed.image, null)
  assertEquals(
    parsed.diagnostics.some((d) => d.code === 'missing_image' && d.blocking),
    true,
  )
})

test('a realistic command compiles to standard compose vocabulary', () => {
  const result = importDockerRunCommand({
    serviceName: 'web',
    argv:
      'docker run -d --name web -p 8080:80 -e TZ=UTC -v site-data:/usr/share/nginx/html ' +
      '--restart unless-stopped -m 512m --cpus 0.5 -w /app --health-cmd "curl -f localhost" ' +
      '--health-interval 30s --health-retries 3 nginx:alpine',
  })
  const service = serviceOf(result.compose)
  assertEquals(service.image, 'nginx:alpine')
  assertEquals(service.container_name, 'web')
  assertEquals(service.ports, ['8080:80'])
  assertEquals(service.environment, ['TZ=UTC'])
  assertEquals(service.volumes, ['site-data:/usr/share/nginx/html'])
  assertEquals(service.restart, 'unless-stopped')
  assertEquals(service.mem_limit, '512m')
  assertEquals(service.cpus, 0.5)
  assertEquals(service.working_dir, '/app')
  assertEquals(service.healthcheck, {
    test: ['CMD-SHELL', 'curl -f localhost'],
    interval: '30s',
    retries: 3,
  })
  // The named volume has to be declared or the document is not runnable.
  assertEquals(result.compose.data.volumes, { 'site-data': {} })
  assertEquals(result.riskFlags, [])
})

test('the imported fragment passes the compose pipeline it will be saved through', () => {
  const result = importDockerRunCommand({
    serviceName: 'web',
    argv:
      'docker run -d --name web -p 8080:80 -e TZ=UTC --label owner=platform ' +
      '--label-file /etc/labels --use-api-socket --ulimit nofile=1024:2048 ' +
      '--log-driver json-file --log-opt max-size=10m --sysctl net.core.somaxconn=1024 ' +
      '--tmpfs /run --add-host db:10.0.0.5 --network app-net --network-alias web ' +
      '--ip 10.5.0.4 nginx:alpine',
  })
  const validated = validateComposeDocument(result.compose)
  assertEquals(validated.ok, true)
  const issues = blockingComposeLintIssues(
    lintComposeYaml(composeDocumentToYaml(result.compose)),
  )
  assertEquals(issues, [])
})

test('operational flags are reported, never written to compose', () => {
  const result = importDockerRunCommand({
    serviceName: 'web',
    argv: 'docker run -d --sig-proxy --cidfile /tmp/cid nginx',
  })
  const service = serviceOf(result.compose)
  assertEquals('detach' in service, false)
  assertEquals('cidfile' in service, false)
  const ignored = result.diagnostics.filter(
    (d) => d.code === 'operational_option_ignored',
  )
  assertEquals(ignored.map((d) => d.flag).sort(), [
    '--cidfile',
    '--sig-proxy',
    '-d',
  ])
  assertEquals(ignored.every((d) => d.blocking === false), true)
})

test('-i and -t become the compose properties that mean the same thing', () => {
  // Compose can say this exactly — `stdin_open` and `tty` — so dropping the
  // flags would import a service that differs from the pasted command.
  const clustered = serviceOf(
    importDockerRunCommand({
      serviceName: 'web',
      argv: 'docker run -itd nginx',
    }).compose,
  )
  assertEquals(clustered.stdin_open, true)
  assertEquals(clustered.tty, true)

  const long = serviceOf(
    importDockerRunCommand({
      serviceName: 'web',
      argv: 'docker run --interactive --tty=false nginx',
    }).compose,
  )
  assertEquals(long.stdin_open, true)
  assertEquals(long.tty, false)

  const result = importDockerRunCommand({
    serviceName: 'web',
    argv: 'docker run -it nginx',
  })
  // ...and they are no longer reported as dropped.
  assertEquals(
    result.diagnostics.some((d) =>
      d.code === 'operational_option_ignored' &&
      (d.flag === '-i' || d.flag === '-t')
    ),
    false,
  )
})

test('--rm and -P are refused with a reason, and the partial import survives', () => {
  const result = importDockerRunCommand({
    serviceName: 'web',
    argv: 'docker run --rm -P nginx:alpine',
  })
  const blocking = result.diagnostics.filter((d) => d.blocking)
  assertEquals(blocking.map((d) => d.flag).sort(), ['--rm', '-P'])
  assertEquals(
    blocking.every((d) => d.code === 'option_unsupported' && d.message.includes('—')),
    true,
  )
  // The caller still gets to show what would have been imported.
  assertEquals(serviceOf(result.compose).image, 'nginx:alpine')
})

test('a Windows-only resource flag is refused rather than aimed at a Linux field', () => {
  const result = importDockerRunCommand({
    serviceName: 'web',
    argv: 'docker run --cpu-percent 50 nginx',
  })
  assertEquals(
    result.diagnostics.some(
      (d) => d.flag === '--cpu-percent' && d.code === 'option_unsupported' && d.blocking,
    ),
    true,
  )
  assertEquals('cpu_percent' in serviceOf(result.compose), false)
})

test('privileged, host namespaces and the docker socket all raise risk flags', () => {
  const result = importDockerRunCommand({
    serviceName: 'web',
    argv:
      'docker run --privileged --cap-add SYS_ADMIN --pid host --ipc host ' +
      '--security-opt seccomp=unconfined --device /dev/fuse ' +
      '-v /var/run/docker.sock:/var/run/docker.sock -v /srv/data:/data nginx',
  })
  assertEquals(result.riskFlags.map((flag) => flag.kind).sort(), [
    'capability_add',
    'device_passthrough',
    'docker_api_socket',
    'host_bind_mount',
    'ipc_namespace',
    'pid_namespace',
    'privileged',
    'security_option',
  ])
  assertEquals(result.riskFlags.every((flag) => flag.message.length > 40), true)
})

test('--network host becomes network_mode and raises the host-network risk', () => {
  const result = importDockerRunCommand({
    serviceName: 'web',
    argv: 'docker run --network host nginx',
  })
  assertEquals(serviceOf(result.compose).network_mode, 'host')
  assertEquals(result.riskFlags.map((flag) => flag.kind), ['host_network'])
})

test('a named network becomes an attachment plus a top-level networks entry', () => {
  const result = importDockerRunCommand({
    serviceName: 'web',
    argv:
      'docker run --network app-net --network-alias web --network-alias api ' +
      '--ip 10.5.0.4 --mac-address 92:d0:c6:0a:29:33 nginx',
  })
  assertEquals(serviceOf(result.compose).networks, {
    'app-net': {
      aliases: ['web', 'api'],
      ipv4_address: '10.5.0.4',
      mac_address: '92:d0:c6:0a:29:33',
    },
  })
  assertEquals(result.compose.data.networks, { 'app-net': {} })
  assertEquals(result.riskFlags, [])
})

test('network aliases with no --network attach to the default network', () => {
  const result = importDockerRunCommand({
    serviceName: 'web',
    argv: 'docker run --network-alias web nginx',
  })
  assertEquals(serviceOf(result.compose).networks, {
    default: { aliases: ['web'] },
  })
  assertEquals(result.compose.data.networks, { default: {} })
})

test('--volume-driver lands on the named volumes it applies to', () => {
  const result = importDockerRunCommand({
    serviceName: 'web',
    argv: 'docker run --volume-driver rexray -v pool:/data -v /srv/host:/host nginx',
  })
  assertEquals(result.compose.data.volumes, { pool: { driver: 'rexray' } })
})

test('--mount becomes compose long syntax and flags a host bind', () => {
  const result = importDockerRunCommand({
    serviceName: 'web',
    argv:
      'docker run --mount type=bind,source=/srv/data,target=/data,readonly ' +
      '--mount type=volume,source=cache,target=/cache nginx',
  })
  assertEquals(serviceOf(result.compose).volumes, [
    { type: 'bind', target: '/data', source: '/srv/data', read_only: true },
    { type: 'volume', target: '/cache', source: 'cache' },
  ])
  assertEquals(result.compose.data.volumes, { cache: {} })
  assertEquals(result.riskFlags.map((flag) => flag.kind), ['host_bind_mount'])
})

test('--stop-timeout becomes a compose duration, not a bare number', () => {
  const result = importDockerRunCommand({
    serviceName: 'web',
    argv: 'docker run --stop-timeout 30 nginx',
  })
  assertEquals(serviceOf(result.compose).stop_grace_period, '30s')
})

test('block IO limits land under blkio_config', () => {
  const result = importDockerRunCommand({
    serviceName: 'web',
    argv:
      'docker run --blkio-weight 300 --blkio-weight-device /dev/sda:400 ' +
      '--device-read-bps /dev/sda:1mb nginx',
  })
  assertEquals(serviceOf(result.compose).blkio_config, {
    weight: 300,
    weight_device: [{ path: '/dev/sda', weight: 400 }],
    device_read_bps: [{ path: '/dev/sda', rate: '1mb' }],
  })
})

test('--gpus all is the bare string the schema allows', () => {
  const all = importDockerRunCommand({
    serviceName: 'web',
    argv: 'docker run --gpus all nginx',
  })
  assertEquals(serviceOf(all.compose).gpus, 'all')

  const specific = importDockerRunCommand({
    serviceName: 'web',
    argv: 'docker run --gpus "device=0,1" nginx',
  })
  assertEquals(serviceOf(specific.compose).gpus, [{ device_ids: ['0', '1'] }])
})

test('nothing is ever written under x-turbopanel', () => {
  const result = importDockerRunCommand({
    serviceName: 'web',
    argv: 'docker run --privileged -v /:/host --network host nginx',
  })
  const yaml = composeDocumentToYaml(result.compose)
  assertEquals(yaml.includes('x-turbopanel'), false)
  assertEquals(yaml.includes('dockerRunArgs'), false)
})

/**
 * Plausible values for the value-taking flags, so the sweep below exercises a
 * real branch rather than a rejected parse.
 */
const SAMPLE_VALUES: Readonly<Record<string, string>> = {
  '--add-host': 'db:10.0.0.5',
  '--annotation': 'com.example.k=v',
  '--attach': 'stdout',
  '--blkio-weight': '300',
  '--blkio-weight-device': '/dev/sda:400',
  '--cap-add': 'SYS_ADMIN',
  '--cap-drop': 'NET_RAW',
  '--cgroup-parent': '/tp',
  '--cgroupns': 'private',
  '--cidfile': '/tmp/cid',
  '--cpu-count': '2',
  '--cpu-percent': '50',
  '--cpu-period': '100000',
  '--cpu-quota': '50000',
  '--cpu-rt-period': '1000',
  '--cpu-rt-runtime': '950',
  '--cpu-shares': '512',
  '--cpus': '1.5',
  '--cpuset-cpus': '0-3',
  '--cpuset-mems': '0',
  '--detach-keys': 'ctrl-p',
  '--device': '/dev/fuse',
  '--device-cgroup-rule': 'c 1:3 mr',
  '--device-read-bps': '/dev/sda:1mb',
  '--device-read-iops': '/dev/sda:100',
  '--device-write-bps': '/dev/sda:1mb',
  '--device-write-iops': '/dev/sda:100',
  '--dns': '1.1.1.1',
  '--dns-option': 'ndots:2',
  '--dns-search': 'example.com',
  '--domainname': 'example.com',
  '--entrypoint': '/bin/sh',
  '--env': 'A=b',
  '--env-file': '/etc/env',
  '--expose': '9000',
  '--gpus': 'all',
  '--group-add': 'audio',
  '--health-cmd': 'curl -f localhost',
  '--health-interval': '30s',
  '--health-retries': '3',
  '--health-start-interval': '5s',
  '--health-start-period': '10s',
  '--health-timeout': '5s',
  '--hostname': 'web',
  '--io-maxbandwidth': '10mb',
  '--io-maxiops': '100',
  '--ip': '10.5.0.4',
  '--ip6': '2001:db8::33',
  '--ipc': 'host',
  '--isolation': 'default',
  '--label': 'owner=platform',
  '--label-file': '/etc/labels',
  '--link': 'db:db',
  '--link-local-ip': '169.254.1.1',
  '--log-driver': 'json-file',
  '--log-opt': 'max-size=10m',
  '--mac-address': '92:d0:c6:0a:29:33',
  '--memory': '512m',
  '--memory-reservation': '256m',
  '--memory-swap': '1g',
  '--memory-swappiness': '60',
  '--mount': 'type=volume,source=cache,target=/cache',
  '--name': 'web',
  '--network': 'app-net',
  '--network-alias': 'web',
  '--oom-score-adj': '500',
  '--pid': 'host',
  '--pids-limit': '100',
  '--platform': 'linux/amd64',
  '--publish': '8080:80',
  '--pull': 'always',
  '--restart': 'unless-stopped',
  '--runtime': 'runc',
  '--security-opt': 'seccomp=unconfined',
  '--shm-size': '64m',
  '--stop-signal': 'SIGTERM',
  '--stop-timeout': '30',
  '--storage-opt': 'size=20G',
  '--sysctl': 'net.core.somaxconn=1024',
  '--tmpfs': '/run',
  '--ulimit': 'nofile=1024:2048',
  '--user': 'root',
  '--userns': 'host',
  '--uts': 'host',
  '--volume': 'data:/data',
  '--volume-driver': 'local',
  '--volumes-from': 'other',
  '--workdir': '/app',
}

test('every registry option has a compiler branch — none falls through', () => {
  // The `default:` arm in `to-compose.ts` fires for a flag the registry says is
  // importable and the compiler has no mapping for. That is the drift this
  // sweep catches: adding a row to the option table without wiring it up.
  for (const definition of DOCKER_RUN_OPTIONS) {
    const flag = dockerRunOptionName(definition)
    const value = definition.value === 'required'
      ? SAMPLE_VALUES[flag] ?? 'value'
      : null
    const argv = value === null
      ? ['docker', 'run', flag, 'nginx']
      : ['docker', 'run', flag, value, 'nginx']
    const result = importDockerRunCommand({ serviceName: 'web', argv })
    const unmapped = result.diagnostics.filter((diagnostic) =>
      diagnostic.message.includes('has no compose mapping yet')
    )
    assertEquals(unmapped, [], `${flag} has no compiler branch`)
    // And nothing arrived unparseable, which would mean the sample value or the
    // parser disagree about the flag's shape.
    assertEquals(
      result.diagnostics.some((d) => d.code === 'missing_option_value'),
      false,
      `${flag} did not take its value`,
    )
  }
})

test('--no-healthcheck disables the image HEALTHCHECK', () => {
  const result = importDockerRunCommand({
    serviceName: 'web',
    argv: 'docker run --no-healthcheck nginx',
  })
  assertEquals(serviceOf(result.compose).healthcheck, { disable: true })
  assertEquals(result.diagnostics.filter((d) => d.blocking), [])
})
