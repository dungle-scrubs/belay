/**
 * Runs an abortable async operation under a hard timeout: it builds an AbortController, aborts it
 * after `ms`, passes the signal to `run`, and ALWAYS clears the timer once the operation settles
 * (success OR failure). The operation's own result/rejection propagates unchanged - the only thing
 * added is the abort-after-ms plus guaranteed timer cleanup, the boilerplate every timed network/DNS
 * call would otherwise re-implement. An operation that ignores the signal still settles when its
 * underlying primitive (fetch, dns lookup) honors the abort. Callers that prefer a sentinel over a
 * rejection wrap the result (e.g. `.catch(() => null)`); centralizing the abort/cleanup here makes it
 * the one place to later add abort-reasons or metrics.
 *
 * Zero-dependency and isomorphic (AbortController/setTimeout are globals in the browser and Node >=
 * 22), exposed via the `@trevor/session/async` subpath so node-only callers import just this.
 */
export function raceTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return run(controller.signal).finally(() => clearTimeout(timer));
}
