# `docker run` importer — AGENTS.md

Turns a pasted `docker container run` command into a one-service
`ComposeDocument`. Root context: `../../../AGENTS.md`. The compose model this
produces: `../compose/AGENTS.md`. Client surface:
`../../client/docker-run/routes.ts`, documented in
`../../client/openapi/docker-run.ts`.

## Two rules

**Never shell out.** `lexer.ts` is a hand-written tokenizer, not a call to
`sh -c`. The input is text a signed-in user pastes into a web form; handing it
to a shell would make a text box on the dashboard an RCE endpoint on the control
plane. Quoting and backslash escapes are honoured because that is how a value
with a space arrives intact. Command substitution (`$(…)`, backticks),
pipelines, sequencing, redirection and globs are **literal characters** — each
raises a non-blocking warning so the operator is told the text was taken
literally rather than discovering it inside a running container. `$(…)` and
`` `…` `` are consumed as one token (not split on their inner spaces) so
`-e UID=$(id -u)` stays one argument instead of handing `-u)` to the parser as a
real `--user`.

**Never invent vocabulary.** The output is an ordinary compose document that the
five-stage pipeline in `../compose/` validates like any hand-authored one.
Nothing is written under `x-turbopanel`, and the pasted command is not persisted
anywhere — a second stored format for "what the operator originally typed" would
drift from the document actually deployed, and a reader would have no way to
tell which one produced the running container.

## Why the option registry is exhaustive

`option-registry.ts` enumerates **every** option `docker container run` accepts —
103 of them, including the four Windows-only resource flags and
`--disable-content-trust`, which are hidden from the Linux `--help` output but
real.

It has to be exhaustive because of how this parser fails. The boundary between
`[OPTIONS]` and `IMAGE` is decided entirely by whether each flag is recognized
*and* whether it takes a value. A flag the table does not know does not raise an
error on its own — it makes the *next* token look like the image. One
unclassified flag silently produces a plausible, wrong compose document.

So `option-registry.fixture.json` pins every `names`/`behavior` pair and
`option-registry.test.ts` diffs the live table against it. Adding or
reclassifying an option means editing both in the same commit; a new Docker flag
that nobody classified fails CI instead of being mis-parsed at runtime. The test
carries the regeneration command.

Four behaviors, the same honesty contract as `../compose/field-policy.ts`:

| behavior      | what happens                                              | blocking |
| ------------- | --------------------------------------------------------- | -------- |
| `compose`     | written onto a standard Compose field                      | —        |
| `transform`   | intent survives in another shape (per-container network arguments become a network attachment plus a top-level `networks:` entry) | —        |
| `operational` | describes the CLI invocation, not the container (`-d`, `--sig-proxy`, `--cidfile`) — reported and dropped | no       |
| `unsupported` | TurboPanel has no behavior for it — reported with a `reason` | yes      |

`unsupported` and `operational` entries **must** carry a `reason`; the test
enforces it, because a bare "not imported" tells an operator nothing they can
act on.

## Risk flags

Flags that widen the container's blast radius carry a `risk` string, collected
into `riskFlags: { kind, source, message }[]`. Two of them are judged on the
*value*, not the flag: `--network` only raises `host_network` for `host`, and
`-v` / `--mount` only raise `host_bind_mount` when the source is a host path
(escalating to `docker_api_socket` for the Docker socket itself). A named volume
raises nothing.

Risk flags are **not** a gate on the import; they are what the caller has to
show the operator, and authorize against, before merging the fragment. They come
back only on a successful import.

A blocking diagnostic is separate and unconditional: the route answers **422**
`docker_run_unsupported` and there is no acknowledgement that turns it into a
success. Dropping `--rm`, `-P` or a mistyped flag on the operator's say-so would
import a service that does not mean what they pasted, so the command gets fixed
instead.

## Compose keys this importer depends on

`--label-file` and `--use-api-socket` map onto the Compose Specification's
`label_file` and `use_api_socket`. Both were added to `SERVICE_FIELD_POLICY`
(`../compose/field-policy.ts`, and its byte-mirrored copy in
`ui/src/lib/compose/field-policy.ts`) so the imported fragment saves instead of
tripping the linter's unknown-key rule.
