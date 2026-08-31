/**
 * Deploy-time validation of the **merged effective** compose document.
 *
 * The pipeline, in the order it has to run:
 *
 * 1. **Upstream Compose Specification** — `./upstream-schema.ts`, a vendored
 *    copy pinned to one revision. "Is this a Compose file."
 * 2. **`x-turbopanel` extension schema** — `validateComposeDocument` /
 *    `collectRootExtensionValidationIssues` in `./validate.ts`. "Is the
 *    TurboPanel block well formed."
 * 3. **Semantic linter** — `lintComposeYaml` in `./lint.ts`. "Do the references
 *    resolve, does each service have something to run, is a principal named
 *    where one is required."
 * 4. **Policy** — `./field-policy.ts` under `strict: true`. "Will TurboPanel
 *    actually honour every field this document sets."
 * 5. **Compiler** — `./compile-runtime.ts`, which assumes 1–4 already ran.
 *
 * This module runs 1–4 over the merged document and returns the first stage
 * that refuses it.
 *
 * ## Why all four stages, and not only the policy one
 *
 * Stages 1–3 run at the write boundary, so every *stored layer* has been
 * through them — but a deploy does not run a stored layer, it runs the **merge
 * of several**, and no save ever validated that. `!reset` on a base service's
 * `image` leaves a service with nothing to run; an overlay that resets the root
 * `x-turbopanel.principals` map orphans every service alias the base declared;
 * an overlay that replaces a scalar with a mapping produces a shape the Compose
 * Specification does not allow. Each of those is two valid saves whose *sum* is
 * invalid, and each used to reach the compiler — which is entitled to assume
 * stages 1–4 already passed — or the daemon.
 *
 * The old objection to re-gating deploys on stages 1–3 was that a document
 * which saved cleanly under one release could become undeployable under the
 * next without anyone touching it. That objection is about the *authored*
 * layers, and it still holds: nothing here re-litigates a stored layer on its
 * own. What is validated is the merged document, which is not a stored artifact
 * at all — it is derived fresh on every deploy, and it has to be a document
 * TurboPanel can actually run.
 *
 * Stage 4 is the one that cannot run at save time at all, because its answer
 * depends on *when* you ask: while editing, a field TurboPanel cannot honour is
 * advice (the author is mid-thought, and refusing the save strands them); at
 * deploy it is a refusal, because the alternative is running something quietly
 * different from what the document says.
 *
 * Stage 4 is not only a per-key pass. Three of its rules judge a **value** or a
 * **sub-key**, because for those the key's own verdict is not the whole answer,
 * and each carries the same `field_unsupported` code so this module refuses
 * them alongside the unsupported keys:
 *
 * - `deploy.mode: replicated-job` / `global-job` — a finite-job controller this
 *   platform does not have.
 * - `deploy.resources.reservations` — a scheduler admission requirement with no
 *   per-host capacity inventory to admit against, under a `resources` key that
 *   is otherwise passthrough.
 * - `deploy.restart_policy` on a `serviceKind: node` service — values the
 *   generated systemd unit cannot express, on the one lane where the key is
 *   translated rather than handed to Docker.
 */

import { composeDocumentToYaml } from './convert.ts'
import { lintComposeYaml, type ComposeLintIssue } from './lint.ts'
import { principalAliasesInComposeData } from './root-extension.ts'
import type { ComposeDocument } from './types.ts'
import { validateComposeDocument, type ComposeValidationIssue } from './validate.ts'

/**
 * A merged document that names a field TurboPanel does not implement.
 *
 * Distinct from `compose_merged_invalid` on purpose: that one means "this was
 * never a valid document", and the fix is to correct it. This one means "this is
 * a valid Compose document naming something *this platform* does not do", and
 * the fix is to remove the field or to deploy it somewhere that honours it.
 * Telling an operator the wrong one of those two sends them looking for a typo
 * that is not there.
 */
export type ComposeUnsupportedFieldError = {
  kind: 'compose_field_unsupported'
  issues: ComposeValidationIssue[]
}

/**
 * The merge of layers that each saved cleanly is not itself a valid document.
 *
 * Its own kind rather than the plain save-time `compose_invalid`, because the
 * operator's next move is different: no single stored layer is wrong, so the
 * fix is in how the overlay changes the base — most often a `!reset` that
 * removed something the base still depends on.
 */
export type ComposeMergedInvalidError = {
  kind: 'compose_merged_invalid'
  issues: ComposeValidationIssue[]
}

/** Everything {@link validateComposeForDeploy} can refuse a deploy with. */
export type ComposeDeployValidationError =
  | ComposeMergedInvalidError
  | ComposeUnsupportedFieldError

function toValidationIssue(issue: ComposeLintIssue): ComposeValidationIssue {
  return {
    path: issue.path,
    message: issue.message,
    ...(issue.level === undefined ? {} : { level: issue.level }),
    ...(issue.line === undefined ? {} : { line: issue.line }),
  }
}

/**
 * Run stages 1–4 over a merged effective document.
 *
 * Returns `null` when the document is structurally valid, semantically
 * coherent, and sets only fields TurboPanel handles.
 */
export function validateComposeForDeploy(
  document: ComposeDocument,
): ComposeDeployValidationError | null {
  // Stages 1–3. `validateComposeDocument` runs the vendored Compose schema, the
  // `x-turbopanel` extension schema and the semantic linter in that order, and
  // returns the first that refuses.
  //
  // The principal aliases come from the merged document's own root because
  // after a merge that is the whole of the scope — the base's map and the
  // overlay's edits to it have already been folded together, so an alias that
  // no longer resolves here does not resolve anywhere. This is the check that
  // catches an overlay `!reset` on `x-turbopanel.principals`; passing nothing
  // would skip the rule (see `ComposeLintOptions.knownPrincipalAliases`) and
  // let the deploy run services as nobody.
  const structural = validateComposeDocument(document, {
    knownPrincipalAliases: principalAliasesInComposeData(document.data),
  })
  if (!structural.ok) {
    return { kind: 'compose_merged_invalid', issues: structural.issues }
  }

  // Stage 4 — the deploy-time-only posture. Filtered to the field-policy code
  // rather than taken wholesale, because `strict: true` changes the severity of
  // exactly those diagnostics and nothing else; every other rule already had
  // its say above, at the severity it means.
  const unsupported = lintComposeYaml(composeDocumentToYaml(document), {
    strict: true,
  }).filter((issue) => issue.code === 'field_unsupported')

  if (unsupported.length === 0) return null
  return {
    kind: 'compose_field_unsupported',
    issues: unsupported.map(toValidationIssue),
  }
}
