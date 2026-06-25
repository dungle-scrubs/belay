/**
 * The single char→token heuristic for the host. Real token counts come from the model's reported
 * `usage`; this is the deliberately rough proxy used only where no measurement exists - the usage
 * breakdown display (usage/breakdown.ts) and compaction budgeting (agent/compaction.ts,
 * agent/compactor.ts). Kept in ONE place so the estimate and its rounding can never drift between
 * those callers (it previously lived in three modules, two of which rounded differently).
 *
 * ~4 chars/token; `Math.round` because this is an estimate, not a hard cap. The compaction budget
 * gate itself never relies on this - it gates on the model's real `usage.input` - so a sub-token
 * rounding choice here only affects displayed/estimated figures, never the actual trigger.
 */
export const CHARS_PER_TOKEN = 4;

/** Estimates tokens from a character count via the shared ~4 chars/token heuristic. */
export const estimateTokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);
