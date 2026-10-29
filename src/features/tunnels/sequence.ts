/**
 * Small helpers for work that must run one item after another (certificate
 * requests count against a limit and a provider token is tried in order), without
 * a loop that awaits inside its body.
 */

/** Run `run` for each item in order, one at a time, and return the results in order. */
export async function inSequence<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = []
  await items.reduce<Promise<void>>(
    (previous, item) =>
      previous.then(async () => {
        out.push(await run(item))
      }),
    Promise.resolve()
  )
  return out
}

/**
 * Try each item in order until `run` gives a result other than `undefined`; the
 * later items are not tried. `run` decides what to do with a refusal: return
 * `undefined` to move on to the next item, or throw to stop.
 */
export async function firstResult<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R | undefined>
): Promise<R | undefined> {
  return await items.reduce<Promise<R | undefined>>(
    (previous, item) => previous.then((found) => (found === undefined ? run(item) : found)),
    Promise.resolve(undefined)
  )
}
