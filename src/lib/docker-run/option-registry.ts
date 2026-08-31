/**
 * Every option `docker container run` accepts, and what TurboPanel does with it.
 *
 * This is the `docker run` half of the same idea as `../compose/field-policy.ts`:
 * one table, one honest answer per flag, so a flag can never be silently
 * swallowed. The failure mode this exists to prevent is specific and nasty — a
 * `docker run` parser that does not recognize a flag treats the *next* token as
 * the IMAGE, so one unknown option turns `--shiny-new-flag nginx:alpine` into
 * "image `nginx:alpine`" or, worse, "image `--shiny-new-flag`". A table that
 * enumerates the whole surface, pinned by a committed fixture
 * (`./option-registry.fixture.json`), makes a new Docker flag a CI failure
 * instead of a mis-parse.
 *
 * Pure data plus lookups: no shell, no `child_process`, no Docker. Nothing in
 * this module executes anything — see `./lexer.ts` for why that matters.
 */

/**
 * What the importer does with a flag.
 *
 * - `compose` — maps onto a standard Compose service (or top-level) field.
 *   Written straight through by `./to-compose.ts`.
 * - `transform` — the intent survives, but not as a one-to-one field copy:
 *   Docker's per-container network arguments become a Compose network
 *   attachment plus a top-level `networks:` entry, and so on.
 * - `operational` — a property of *this invocation of the CLI*, not of the
 *   container. Compose has nowhere to put it and losing it changes nothing
 *   about what runs, so it is reported as a non-blocking note and dropped.
 * - `unsupported` — TurboPanel has no behavior for it. Reported as a blocking
 *   diagnostic with {@link DockerRunOptionDefinition.reason}, never dropped in
 *   silence.
 */
export type DockerRunOptionBehavior =
  | 'compose'
  | 'transform'
  | 'operational'
  | 'unsupported'

/**
 * How the flag takes its argument.
 *
 * - `required` — `--flag value`, `--flag=value`, or (shorthand) `-fvalue`.
 * - `optional` — a boolean: `--flag` alone, or `--flag=false`. It **never**
 *   consumes the following token, which is what lets `-it` cluster and what
 *   keeps `docker run -d nginx` from reading `nginx` as the value of `-d`.
 * - `none` — takes no argument at all, not even `=`.
 */
export type DockerRunOptionValue = 'none' | 'required' | 'optional'

/** Host platform the flag exists for. `any` is the common case. */
export type DockerRunOptionPlatform = 'any' | 'linux' | 'windows'

export type DockerRunOptionDefinition = {
  /** Every spelling, shorthand first, canonical long name last. */
  names: readonly string[]
  value: DockerRunOptionValue
  /** Docker `list` / `map` valued flags may be repeated; scalars may not. */
  repeatable: boolean
  platform: DockerRunOptionPlatform
  behavior: DockerRunOptionBehavior
  /**
   * Why importing this flag widens the container's blast radius. Present only
   * on flags that actually do; the importer collects them into
   * `riskFlags` so the operator confirms them before the fragment is merged.
   */
  risk?: string
  /**
   * Required when {@link DockerRunOptionDefinition.behavior} is `unsupported`
   * or `operational` — the diagnostic quotes it verbatim, so it has to name
   * what is missing rather than restate that the flag was not imported. Same
   * contract as `ComposeFieldPolicy.reason`.
   */
  reason?: string
}

/** Shared risk prose, so the same hazard reads identically wherever it lands. */
const RISK = {
  privileged:
    'a privileged container gets every capability, an unmasked /proc and /sys, and access to every host device — it is root on the host in all but name',
  capAdd:
    'added Linux capabilities are host-level privileges; SYS_ADMIN, SYS_PTRACE and NET_ADMIN in particular are routinely enough to escape the container',
  device:
    'a passed-through host device is reachable by the container with whatever access the rule grants, outside any namespace the container is otherwise confined to',
  deviceCgroupRule:
    'a cgroup device rule grants access to host device nodes by major/minor number, including devices that do not exist yet when the rule is written',
  pid:
    'sharing a PID namespace (notably `host`) lets the container see and signal processes outside itself, and read their /proc — including their environment and secrets',
  ipc:
    'sharing an IPC namespace exposes host shared memory and semaphores to the container, in both directions',
  network:
    'host networking removes network isolation entirely: the container binds host ports directly and can reach anything the host can, including loopback-only services',
  userns:
    'overriding the user namespace (notably `host`) disables the UID remapping that keeps container root from being host root',
  cgroupns:
    'joining the host cgroup namespace exposes the host cgroup hierarchy, which leaks host topology and is a common step in container escapes',
  securityOpt:
    'security options tune or switch off seccomp, AppArmor, SELinux and no-new-privileges — the confinement layers that make everything else on this list survivable',
  useApiSocket:
    'bind-mounting the Docker API socket gives the container full control of the daemon, which is equivalent to root on the host',
  mount:
    'a bind mount of a host path gives the container direct read (and, unless read-only, write) access to that path on the server',
} as const

/**
 * The complete `docker container run` option surface.
 *
 * Ordered by canonical long name, matching `docker container run --help`, so a
 * reader can diff the two by eye. Four options are hidden from the Linux help
 * output but real — `--disable-content-trust` and the four Windows-only
 * resource flags — and are listed here for the same reason everything else is:
 * an option this table does not know about becomes a mis-parsed IMAGE.
 */
export const DOCKER_RUN_OPTIONS: readonly DockerRunOptionDefinition[] = [
  {
    names: ['--add-host'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--annotation'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['-a', '--attach'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'operational',
    reason:
      'attaching streams describes how one CLI invocation is wired to a terminal, not how the container runs',
  },
  {
    names: ['--blkio-weight'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--blkio-weight-device'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--cap-add'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
    risk: RISK.capAdd,
  },
  {
    names: ['--cap-drop'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--cgroup-parent'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--cgroupns'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
    risk: RISK.cgroupns,
  },
  {
    names: ['--cidfile'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'operational',
    reason:
      'the container id is written to a file on whichever machine ran the CLI; a Compose service has no equivalent one-shot side effect',
  },
  {
    names: ['--cpu-count'],
    value: 'required',
    repeatable: false,
    platform: 'windows',
    behavior: 'unsupported',
    reason:
      'a Windows-container CPU control, and TurboPanel schedules onto Linux hosts — use --cpus, which both engines enforce',
  },
  {
    names: ['--cpu-percent'],
    value: 'required',
    repeatable: false,
    platform: 'windows',
    behavior: 'unsupported',
    reason:
      'a Windows-container CPU control, and TurboPanel schedules onto Linux hosts — use --cpus, which both engines enforce',
  },
  {
    names: ['--cpu-period'],
    value: 'required',
    repeatable: false,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['--cpu-quota'],
    value: 'required',
    repeatable: false,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['--cpu-rt-period'],
    value: 'required',
    repeatable: false,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['--cpu-rt-runtime'],
    value: 'required',
    repeatable: false,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['-c', '--cpu-shares'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--cpus'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--cpuset-cpus'],
    value: 'required',
    repeatable: false,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['--cpuset-mems'],
    value: 'required',
    repeatable: false,
    platform: 'linux',
    behavior: 'unsupported',
    reason:
      'the Compose Specification has a cpuset field for CPUs and none for NUMA memory nodes, so this pin has nowhere to be written and would be lost on save',
  },
  {
    names: ['-d', '--detach'],
    value: 'optional',
    repeatable: false,
    platform: 'any',
    behavior: 'operational',
    reason:
      'every Compose service already runs detached; foreground is a property of the CLI invocation',
  },
  {
    names: ['--detach-keys'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'operational',
    reason: 'a terminal key binding for the attached CLI, not container configuration',
  },
  {
    names: ['--device'],
    value: 'required',
    repeatable: true,
    platform: 'linux',
    behavior: 'compose',
    risk: RISK.device,
  },
  {
    names: ['--device-cgroup-rule'],
    value: 'required',
    repeatable: true,
    platform: 'linux',
    behavior: 'compose',
    risk: RISK.deviceCgroupRule,
  },
  {
    names: ['--device-read-bps'],
    value: 'required',
    repeatable: true,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['--device-read-iops'],
    value: 'required',
    repeatable: true,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['--device-write-bps'],
    value: 'required',
    repeatable: true,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['--device-write-iops'],
    value: 'required',
    repeatable: true,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['--disable-content-trust'],
    value: 'optional',
    repeatable: false,
    platform: 'any',
    behavior: 'operational',
    reason:
      'image signature verification is a client-side policy of the machine that pulls, and TurboPanel pulls from the daemon on the target server',
  },
  {
    names: ['--dns'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--dns-option'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--dns-search'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--domainname'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--entrypoint'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['-e', '--env'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--env-file'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--expose'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--gpus'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--group-add'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--health-cmd'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--health-interval'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--health-retries'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--health-start-interval'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--health-start-period'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--health-timeout'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--help'],
    value: 'optional',
    repeatable: false,
    platform: 'any',
    behavior: 'operational',
    reason: 'prints CLI usage; there is nothing to import',
  },
  {
    names: ['-h', '--hostname'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--init'],
    value: 'optional',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['-i', '--interactive'],
    value: 'optional',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--io-maxbandwidth'],
    value: 'required',
    repeatable: false,
    platform: 'windows',
    behavior: 'unsupported',
    reason:
      'a Windows-container IO control, and TurboPanel schedules onto Linux hosts — use --device-read-bps / --device-write-bps',
  },
  {
    names: ['--io-maxiops'],
    value: 'required',
    repeatable: false,
    platform: 'windows',
    behavior: 'unsupported',
    reason:
      'a Windows-container IO control, and TurboPanel schedules onto Linux hosts — use --device-read-iops / --device-write-iops',
  },
  {
    names: ['--ip'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'transform',
  },
  {
    names: ['--ip6'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'transform',
  },
  {
    names: ['--ipc'],
    value: 'required',
    repeatable: false,
    platform: 'linux',
    behavior: 'compose',
    risk: RISK.ipc,
  },
  {
    names: ['--isolation'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['-l', '--label'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--label-file'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--link'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'transform',
  },
  {
    names: ['--link-local-ip'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'transform',
  },
  {
    names: ['--log-driver'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--log-opt'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--mac-address'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'transform',
  },
  {
    names: ['-m', '--memory'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--memory-reservation'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--memory-swap'],
    value: 'required',
    repeatable: false,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['--memory-swappiness'],
    value: 'required',
    repeatable: false,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['--mount'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
    risk: RISK.mount,
  },
  {
    names: ['--name'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--network'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'transform',
    risk: RISK.network,
  },
  {
    names: ['--network-alias'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'transform',
  },
  {
    names: ['--no-healthcheck'],
    value: 'optional',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--oom-kill-disable'],
    value: 'optional',
    repeatable: false,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['--oom-score-adj'],
    value: 'required',
    repeatable: false,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['--pid'],
    value: 'required',
    repeatable: false,
    platform: 'linux',
    behavior: 'compose',
    risk: RISK.pid,
  },
  {
    names: ['--pids-limit'],
    value: 'required',
    repeatable: false,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['--platform'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--privileged'],
    value: 'optional',
    repeatable: false,
    platform: 'linux',
    behavior: 'compose',
    risk: RISK.privileged,
  },
  {
    names: ['-p', '--publish'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['-P', '--publish-all'],
    value: 'optional',
    repeatable: false,
    platform: 'any',
    behavior: 'unsupported',
    reason:
      'it publishes every exposed port to a random host port chosen at start time, so the same document deploys to different host ports on every restart and no hosting route could point at it — publish the ports you mean with -p',
  },
  {
    names: ['--pull'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['-q', '--quiet'],
    value: 'optional',
    repeatable: false,
    platform: 'any',
    behavior: 'operational',
    reason: 'suppresses CLI pull output; it says nothing about the container',
  },
  {
    names: ['--read-only'],
    value: 'optional',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--restart'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--rm'],
    value: 'optional',
    repeatable: false,
    platform: 'any',
    behavior: 'unsupported',
    reason:
      'it means "throw this container and its anonymous volumes away when it exits", which is the opposite of a Compose service TurboPanel keeps reconciled and restarts — importing it would silently produce a long-running service',
  },
  {
    names: ['--runtime'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--security-opt'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
    risk: RISK.securityOpt,
  },
  {
    names: ['--shm-size'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--sig-proxy'],
    value: 'optional',
    repeatable: false,
    platform: 'any',
    behavior: 'operational',
    reason:
      'signal proxying wires the CLI process to the container; there is no CLI process in front of a deployed service',
  },
  {
    names: ['--stop-signal'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--stop-timeout'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--storage-opt'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--sysctl'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--tmpfs'],
    value: 'required',
    repeatable: true,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['-t', '--tty'],
    value: 'optional',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--ulimit'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--use-api-socket'],
    value: 'optional',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
    risk: RISK.useApiSocket,
  },
  {
    names: ['-u', '--user'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['--userns'],
    value: 'required',
    repeatable: false,
    platform: 'linux',
    behavior: 'compose',
    risk: RISK.userns,
  },
  {
    names: ['--uts'],
    value: 'required',
    repeatable: false,
    platform: 'linux',
    behavior: 'compose',
  },
  {
    names: ['-v', '--volume'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
    risk: RISK.mount,
  },
  {
    names: ['--volume-driver'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'transform',
  },
  {
    names: ['--volumes-from'],
    value: 'required',
    repeatable: true,
    platform: 'any',
    behavior: 'compose',
  },
  {
    names: ['-w', '--workdir'],
    value: 'required',
    repeatable: false,
    platform: 'any',
    behavior: 'compose',
  },
] as const

/**
 * The canonical (long) name of a definition — the last entry in `names`.
 *
 * Every consumer keys off this rather than off whatever the operator typed, so
 * `-v` and `--volume` reach the same branch in `./to-compose.ts`.
 */
export function dockerRunOptionName(
  definition: DockerRunOptionDefinition,
): string {
  return definition.names.at(-1)!
}

const OPTIONS_BY_NAME: ReadonlyMap<string, DockerRunOptionDefinition> = new Map(
  DOCKER_RUN_OPTIONS.flatMap((definition) =>
    definition.names.map(
      (name) => [name, definition] as [string, DockerRunOptionDefinition],
    )
  ),
)

/** Look a flag up by any spelling (`-v`, `--volume`). */
export function lookupDockerRunOption(
  name: string,
): DockerRunOptionDefinition | undefined {
  return OPTIONS_BY_NAME.get(name)
}

/** Every spelling the registry knows, for "did you mean" on an unknown flag. */
export const DOCKER_RUN_OPTION_NAMES: ReadonlySet<string> = new Set(
  OPTIONS_BY_NAME.keys(),
)
