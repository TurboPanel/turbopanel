# Vendored upstream schemas

## `compose-spec.schema.json`

The official Compose Specification JSON Schema (Draft 2020-12), copied
**byte-for-byte** so a reviewer can diff it against upstream.

| | |
| --- | --- |
| Source | `https://github.com/compose-spec/compose-spec` |
| Path | `schema/compose-spec.json` |
| Pinned revision | `4e2fe7602af8c965ab4fef891e9dde9c5940775f` |
| SHA-256 | `73ca5878c77570ba222a558016c7b3c6770ba5f3377786593e32180666512f8f` |

### Rules

- **Never fetched from upstream `main`** — not at runtime, not at build time,
  not in a test. A schema that moves under the deployment is a validator whose
  verdict on the same document changes without a commit; every refusal this
  file produces has to be attributable to a reviewed change in this repository.
- Refreshing it is a deliberate change: re-fetch at a **new pinned revision**,
  update the three rows above, and run `deno task test:compose` — the vendored
  copy is exercised by `../upstream-schema.test.ts`, so a spec change that
  starts refusing documents TurboPanel accepts shows up as a failing test rather
  than as a broken save.
- Do not hand-edit the JSON. TurboPanel-specific policy (which fields this
  control plane actually implements, and what it does with them) belongs in
  `../field-policy.ts`, never in the vendored copy.

To refresh:

```sh
REV=<new-commit-sha>
curl -fsSL "https://raw.githubusercontent.com/compose-spec/compose-spec/$REV/schema/compose-spec.json" \
  -o src/lib/compose/vendor/compose-spec.schema.json
sha256sum src/lib/compose/vendor/compose-spec.schema.json
```
