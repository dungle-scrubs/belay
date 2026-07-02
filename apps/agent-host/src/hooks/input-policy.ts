import { asRecord } from "@host/boot/decode";

/**
 * The `updatedInput` allowlist policy (plan 25 M6, D-003): which tool-input LEAF fields a
 * PreToolUse hook may rewrite. The table is deliberately tiny and reviewable - hidden-state
 * rewrites are impossible BY CONSTRUCTION because only named leaf fields on named tools pass,
 * and a rewritten value still goes through the tool's normal schema decode at the executor
 * boundary (a hook can never bypass validation, only substitute a value the model could have
 * sent). One unsupported field poisons the WHOLE update: partial application would make "which
 * input actually ran?" ambiguous, so rejection means the original input runs and a diagnostic
 * surfaces.
 *
 * | tool      | rewritable field | why it is safe to scope                                     |
 * |-----------|------------------|--------------------------------------------------------------|
 * | bash      | command          | the whole observable input; validated by bash's own schema   |
 * | web_fetch | url              | the whole observable input; validated + SSRF-guarded as usual |
 *
 * Growing the table is a code review, not a config change.
 *
 * Responsible for: the per-tool updatedInput field allowlist and its evaluation verdict.
 * Not for: applying the update to a call (@host/agent/loop-tool-calls) or dispatching hooks
 * (./runtime).
 */

/** The per-tool allowlist of hook-rewritable leaf input fields. Narrow on purpose (D-003). */
export const HOOK_UPDATABLE_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  bash: ["command"],
  web_fetch: ["url"],
};

/** The policy verdict: the whitelisted fields to apply, or a structured rejection. Values are
 *  NOT type-checked here - the tool's schema decode owns value validation. */
export type UpdatedInputEvaluation =
  | { readonly ok: true; readonly fields: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly detail: string };

/** Evaluates one hook's `updatedInput` against the allowlist for `toolName`. Pure. */
export function evaluateUpdatedInput(
  toolName: string,
  updatedInput: unknown,
): UpdatedInputEvaluation {
  const record = asRecord(updatedInput);
  if (!record) {
    return { ok: false, detail: "updatedInput must be a JSON object of tool-input fields" };
  }

  const allowed = HOOK_UPDATABLE_INPUT_FIELDS[toolName];
  if (!allowed) {
    const supported = Object.keys(HOOK_UPDATABLE_INPUT_FIELDS)
      .map((tool) => `"${tool}"`)
      .join(", ");
    return {
      ok: false,
      detail: `tool "${toolName}" does not support updatedInput; supported tools: ${supported}`,
    };
  }

  const unsupported = Object.keys(record).filter((field) => !allowed.includes(field));
  if (unsupported.length > 0) {
    return {
      ok: false,
      detail:
        `unsupported updatedInput field(s) for "${toolName}": ${unsupported.join(", ")}; ` +
        `only ${allowed.map((field) => `"${field}"`).join(", ")} may be rewritten`,
    };
  }

  return { ok: true, fields: record };
}
