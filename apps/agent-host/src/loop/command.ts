import {
  classifyLoopCommand,
  LOOP_COMMAND_NAMES,
  LOOP_FAMILY,
  type LoopSnapshot,
  parseLoopCommand,
} from "@trevor/session";
import type { Command } from "../commands";
import type { LoopState } from "./domain";
import type { LoopController } from "./store";

/**
 * The host-owned `/loop` command surface (plan 17, M1 + M8). `/loop` is a command FAMILY, not a text macro:
 * the host re-parses every explicit submission AUTHORITATIVELY over the SAME shared parser the web helper
 * previews with (D-001/D-002), so a headless client that can only send command text drives the full
 * lifecycle - create, list, and the controls - with no builder UI.
 *
 * When a live loop runtime is wired (via the command context), the command DRIVES it: an explicit
 * `/loop <spec>` creation activates directly (typing the full command IS the deliberate, confirmed intent;
 * the pending/confirm flow is for the web builder + the deferred NL layer), `/loop list` reports the
 * inventory, and a control verb (`stop`/`pause`/`resume`/`run-now`/`delete`) drives that loop. With no
 * runtime available it falls back to a structured parse preview.
 */

/** Renders a parsed `/loop` line into a stable, UI-neutral, structured text result (no rows/chips/colors). */
export function describeLoopParse(input: string): string {
  const routed = classifyLoopCommand(input);
  if (routed.action === "invalid") {
    return `Not a /loop command. Try: ${LOOP_FAMILY.examples[0]?.text ?? '/loop max 5 do "…"'}`;
  }
  if (routed.action === "list") {
    return "action: list - lists the active loops.";
  }
  if (routed.action !== "create") {
    return routed.loopId !== undefined
      ? `action: ${routed.action} - target loop ${routed.loopId}.`
      : `usage: /loop ${routed.action} <id>`;
  }

  const parse = parseLoopCommand(input);
  const set = parse.fields
    .filter((row) => !row.missing && row.value !== undefined)
    .map((row) => `${row.label}: ${row.value}`)
    .join(", ");
  if (parse.ready) {
    return `action: create - ready. ${set}.`;
  }
  const errors = parse.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.message);
  const parts = [
    parse.missing.length > 0 ? `missing ${parse.missing.join(", ")}` : "",
    ...errors,
  ].filter((part) => part.length > 0);
  return `action: create - not ready (${parts.join("; ")}). ${set}`.trimEnd();
}

/** ` (completed/max)` or ` (completed)` - the progress fragment both the status line and inventory show. */
function formatProgress(completed: number, max?: number): string {
  return max !== undefined ? ` (${completed}/${max})` : ` (${completed})`;
}

/** A one-line status for a loop snapshot: `loop_1 running · every 5m · do "x" (2/5)`. */
function formatSnapshot(snapshot: LoopSnapshot): string {
  const progress = formatProgress(snapshot.completed, snapshot.max);
  const reason = snapshot.stopReason !== undefined ? ` [${snapshot.stopReason}]` : "";
  return `${snapshot.loopId} ${snapshot.status} · ${snapshot.summary}${progress}${reason}`;
}

/** Renders the loop inventory (the `/loop list` result). */
function formatInventory(loops: readonly LoopState[]): string {
  if (loops.length === 0) {
    return 'No active loops. Create one with /loop, e.g. /loop max 5 do "run tests".';
  }
  return loops
    .map((loop) => `${loop.id} ${loop.status}${formatProgress(loop.completed, loop.spec.max)}`)
    .join("\n");
}

/** Drives a control verb against the runtime, returning its structured status line or an error. */
function control(controller: LoopController, action: string, loopId: string): string {
  const result = (() => {
    switch (action) {
      case "stop":
        return controller.stop(loopId);
      case "pause":
        return controller.pause(loopId);
      case "resume":
        return controller.resume(loopId);
      case "delete":
        return controller.delete(loopId);
      case "run-now":
        return controller.runNow(loopId);
      default:
        return { ok: false as const, error: `unknown loop action ${action}` };
    }
  })();
  return result.ok ? formatSnapshot(result.snapshot) : `error: ${result.error}`;
}

/** Routes an explicit `/loop` submission to the live runtime and returns its structured result. */
export function routeLoopCommand(input: string, controller: LoopController): string {
  const routed = classifyLoopCommand(input);
  if (routed.action === "invalid") {
    return describeLoopParse(input);
  }
  if (routed.action === "list") {
    return formatInventory(controller.list());
  }
  if (routed.action === "create") {
    // Explicit command = deliberate intent: submit then activate directly (D-004 satisfied by validation).
    const created = controller.submit(input);
    if (!created.ok) {
      return `error: ${created.error}`;
    }
    const activated = controller.confirm(created.snapshot.loopId);
    return activated.ok ? formatSnapshot(activated.snapshot) : `error: ${activated.error}`;
  }
  if (routed.loopId === undefined) {
    return `usage: /loop ${routed.action} <id>`;
  }
  return control(controller, routed.action, routed.loopId);
}

/**
 * The `/loop` and `/loops` command entries for the host registry. The registry strips the command NAME and
 * passes the rest as `args`, so we reconstruct the full line before routing. When a live runtime is present
 * the command drives it; otherwise it answers with a structured parse preview.
 */
export function buildLoopCommands(): Command<{ loops?: LoopController }>[] {
  return LOOP_COMMAND_NAMES.map((name) => ({
    spec: { name, summary: LOOP_FAMILY.summary, usage: `${name} <action…>` },
    select: (ctx) => ({ loops: ctx.loops }),
    run: (args, input) => {
      const line = `${name} ${args}`.trimEnd();
      return input.loops !== undefined
        ? routeLoopCommand(line, input.loops)
        : describeLoopParse(line);
    },
  }));
}
