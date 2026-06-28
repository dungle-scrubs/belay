/**
 * Shared context-overflow text classifier. Provider adapters, host failure taxonomy, and web
 * transcript labels all consume this predicate so the question "does this error mean the prompt or
 * response exceeded the model context?" has one owner.
 */

const CONTEXT_OVERFLOW_TEXT =
  /context|token limit|too long|too many tokens|maximum.*(context|tokens)|reduce the (length|size)|tokens to keep|larger context/i;

/** True when a sanitized error/detail string describes a context-window overflow. */
export function isContextOverflowText(detail: string): boolean {
  return CONTEXT_OVERFLOW_TEXT.test(detail);
}
