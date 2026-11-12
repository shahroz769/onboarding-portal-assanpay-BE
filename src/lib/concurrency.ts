/**
 * Like Promise.all over items.map(fn), but runs at most `limit` calls at
 * once. Results keep the input order. After the first rejection no new
 * calls start, and the call rejects with that error only once the calls
 * already running have settled, so a caller cleaning up after a failure
 * (e.g. deleting uploaded files) sees every side effect that happened.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  let failed = false

  async function worker() {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index] as T, index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }

  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker),
  )
  const rejection = settled.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === 'rejected',
  )
  if (rejection) throw rejection.reason
  return results
}

/** Concurrent Google Drive uploads allowed per request. */
export const DRIVE_UPLOAD_CONCURRENCY = 10
