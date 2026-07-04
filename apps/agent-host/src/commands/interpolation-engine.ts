/**
 * The SHARED interpolation parser + renderer (plan 40, M3). "Interpolation" is expanding a `!command`
 * embedded in a skill or command-file body by substituting the result of running it. This module owns the
 * two things that are identical across skills and command files - the PURE segmenter that finds the two
 * command forms, and the renderer that stitches each segment's expansion back into the body - while the
 * decision of WHETHER and HOW a segment runs is injected as a {@link SegmentExecutor}. Because execution
 * is injected, the parser is unit-tested with no shell at all (M3, D-006), and the two lanes can attach
 * very different execution POLICIES to one audited parse: skills run an arbitrary bounded shell command
 * (skills/skills.ts), command files run only an allow-listed in-process command (commands/command-file.ts).
 *
 * The segment order + count mirror the body's lines: a literal segment is one original line, and a
 * command/block segment is one output slot, so re-joining the rendered segments with "\n" reproduces the
 * body byte-for-byte except at the interpolation sites. This preserves the exact line semantics the
 * pre-existing skill interpolation shipped with.
 *
 * Responsible for: the pure `!command`/```!`` segmenter and the injected-executor renderer.
 * Not for: the gate/allow-list/output policy (interpolation.ts) or the skill-shell executor (skills.ts).
 */

/**
 * One parsed piece of a body. A `literal` is emitted verbatim; a `command` (a whole-line `!cmd`) and a
 * `block` (a fenced ```` ```! ```` script) are each replaced by their executor's output. The `!` prefix
 * and the fence lines are already stripped, so an executor sees only the command/script text.
 */
export type InterpolationSegment =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "block"; readonly script: string };

/** A segment that carries a command to run (everything except a literal). */
export type RunnableSegment = Extract<InterpolationSegment, { kind: "command" | "block" }>;

/** Opens a fenced command block: a line that is exactly ```` ```! ````. */
const OPEN_FENCE = /^```!\s*$/;
/** Closes any fenced block: a line that is exactly ```` ``` ````. */
const CLOSE_FENCE = /^```\s*$/;

/**
 * Segments a body into literals + runnable command/block pieces. Pure and shell-free: it only decides
 * WHAT would run, never runs anything. The rules match the pre-existing skill interpolation exactly:
 *   - a fenced block opening with ```` ```! ```` captures every line up to the next closing ```` ``` ````
 *     (or end of body) as one script;
 *   - a whole trimmed line that starts with `!` (but not `![`, a markdown image) is a single command;
 *   - every other line is a literal, preserved with its original (untrimmed) text.
 */
export function parseInterpolation(body: string): InterpolationSegment[] {
  const lines = body.split("\n");
  const segments: InterpolationSegment[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (OPEN_FENCE.test(trimmed)) {
      const script: string[] = [];
      i += 1;
      for (; i < lines.length; i += 1) {
        const inner = lines[i] ?? "";
        if (CLOSE_FENCE.test(inner.trim())) {
          break;
        }
        script.push(inner);
      }
      // i sits on the closing fence (or end); the loop step moves past it, so the fence lines and the
      // inner script collapse into exactly one output slot - identical to the original skill renderer.
      segments.push({ kind: "block", script: script.join("\n") });
      continue;
    }

    // `![` is a markdown image, never a command (parity with the skill interpolation this replaces).
    if (trimmed.length > 1 && trimmed.startsWith("!") && trimmed[1] !== "[") {
      segments.push({ kind: "command", command: trimmed.slice(1).trim() });
      continue;
    }

    segments.push({ kind: "literal", text: line });
  }

  return segments;
}

/**
 * Expands one runnable segment into the text to splice at its site. An executor owns the policy - the
 * gate, the allow-list, the shell floor or in-process dispatch, and the output caps/redaction - so the
 * shared renderer stays policy-free. It must never reject: a refusal or failure becomes bounded text.
 */
export type SegmentExecutor = (segment: RunnableSegment) => Promise<string>;

/**
 * Renders parsed segments back into one body, running each runnable segment through `execute` in ORDER
 * (sequential, never concurrent) so expansions are deterministic and a body can't fan out a burst of
 * commands. Literals pass through untouched; re-joining with "\n" reproduces the body except at the
 * interpolation sites.
 */
export async function renderInterpolation(
  segments: readonly InterpolationSegment[],
  execute: SegmentExecutor,
): Promise<string> {
  const out: string[] = [];
  for (const segment of segments) {
    out.push(segment.kind === "literal" ? segment.text : await execute(segment));
  }
  return out.join("\n");
}

/** Parses `body` and renders it through `execute` in one call - the shared entry both lanes use. */
export async function interpolate(body: string, execute: SegmentExecutor): Promise<string> {
  return renderInterpolation(parseInterpolation(body), execute);
}
