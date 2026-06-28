import { Schema } from "effect";
import { formatDoctorSnapshot } from "../doctor/build";
import { currentDoctorSnapshot } from "../doctor/source";
import { simpleTool } from "./shared";

/**
 * The `doctor` model-facing tool (D-073 M6): runs Trevor's OWN host self-diagnostic and returns the
 * current health report. It is the same `/doctor` snapshot the user can run as a slash command,
 * built through the shared accessor (../doctor/source), then rendered to the sanitized plaintext
 * report (`formatDoctorReport`) - so the model reads health + repair guidance, not a raw JSON struct.
 *
 * DIAGNOSTIC ONLY. This reads host/provider/internet/tool readiness; it never inspects the user's
 * code and is NOT routine context-gathering. The system prompt (providers/system-prompt.ts) tells
 * the model to call it only when the user asks about Trevor's own health/setup or why a turn failed,
 * never for ordinary coding work. Read-only - it only probes already-sanitized host state - so the
 * loop may run it concurrently with other reads.
 */

// A no-arg tool: an EMPTY object params schema. The explicit `jsonSchema` annotation is load-bearing -
// a bare `Schema.Struct({})` emits an `anyOf` carrying a RELATIVE `$id` URL ("/schemas/%7B%7D"), which
// OpenAI-compatible providers (DeepSeek) reject with "relative URL without a base". The annotation pins
// the clean `{ type: "object", properties: {} }` a no-arg function expects.
const Params = Schema.Struct({}).annotations({
  jsonSchema: { type: "object", properties: {}, additionalProperties: false },
});

export const doctorTool = simpleTool({
  name: "doctor",
  description:
    "Run Trevor's own /doctor host self-diagnostic and return a health report covering providers / " +
    "model auth readiness, public-internet reachability, available tools, storage roots, and the " +
    "workspace - with next-step repair guidance for anything degraded. DIAGNOSTIC ONLY: call this " +
    "only when the user asks about Trevor's own health, setup, provider/model/tool availability, " +
    "connectivity, or why a turn failed. Do NOT call it as routine context for ordinary coding " +
    "tasks; it does not read the user's code (use read/grep/glob for that).",
  params: Params,
  readOnly: true,
  execute: async () => formatDoctorSnapshot(await currentDoctorSnapshot()),
});
