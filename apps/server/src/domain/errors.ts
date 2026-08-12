// Distinct error type for "the upstream provider stalled / reset / timed out
// on its own" — as opposed to "the operator (or the polling divergence gate)
// aborted us via AbortController". Both used to share `err.name === 'AbortError'`,
// which mis-classified genuine network failures as user cancels for any
// downstream code following the JS standard idiom.
export class UpstreamAbortError extends Error {
  override name = 'UpstreamAbortError'
}
