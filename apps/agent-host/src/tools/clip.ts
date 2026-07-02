import type { ChatMessage } from "@host/providers/index";
import { msg } from "@host/transport/messages";
import type { ClipboardWriter } from "./clipboard";

/**
 * The clipboard convenience surface behind `/clip` (plan 06): the immediate bare-`/clip` copy of
 * the last copyable transcript item, and the routing + framing for the restricted `/clip <request>`
 * model turn. This module owns ONLY the copyable-text extraction, the command result text, and the
 * restricted-turn shape; main.ts wires it into the command lane and the turn machine. There is no
 * persisted clipboard state here (D-004) - copied content is visible only as the command/tool
 * result it returns.
 */

/** The single tool a `/clip <request>` turn is allowed to offer + run (D-007). */
export const CLIPBOARD_TOOL_NAMES: ReadonlySet<string> = new Set(["clipboard_write"]);

/** Longest single-line preview of copied text shown in a command result. */
const PREVIEW_MAX = 80;

/** A bounded single-line preview of `text` for a visible result (collapses whitespace). */
function preview(text: string): string {
  const oneLine = text.replace(/\s+/gu, " ").trim();
  return oneLine.length > PREVIEW_MAX ? `${oneLine.slice(0, PREVIEW_MAX)}…` : oneLine;
}

/**
 * The last copyable item in the current session view: the most recent user or assistant message
 * with non-blank text. Tool results and blank/whitespace-only messages are skipped - they are not
 * something a user wants on the clipboard. Returns null when nothing is copyable yet.
 */
export function lastCopyableText(history: readonly ChatMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (!message) {
      continue;
    }
    if ((message.role === "assistant" || message.role === "user") && message.content.trim()) {
      return message.content;
    }
  }
  return null;
}

/** The result of running bare `/clip`: the visible command text and whether it succeeded. */
export interface ClipCopyResult {
  readonly text: string;
  readonly ok: boolean;
}

/**
 * Bare `/clip`: copy the last copyable transcript item through the host clipboard abstraction and
 * return a visible result with a bounded preview + char count. No model turn runs. Empty / no-copyable
 * history returns a clear "nothing to copy" result; a clipboard write failure surfaces as not-ok.
 */
export async function copyLastCopyable(
  history: readonly ChatMessage[],
  writer: ClipboardWriter,
): Promise<ClipCopyResult> {
  const target = lastCopyableText(history);
  if (target === null) {
    return { text: "Nothing to copy: no copyable message in the transcript yet.", ok: false };
  }
  try {
    await writer.write(target);
  } catch (error) {
    return { text: `Clipboard write failed: ${msg(error)}`, ok: false };
  }
  return {
    text: `Copied the last message to the clipboard (${target.length} chars): ${preview(target)}`,
    ok: true,
  };
}

/** The framed user prompt for a restricted `/clip <request>` turn. */
export function buildClipTurnPrompt(request: string): string {
  return [
    `Clipboard request: ${request.trim()}`,
    "",
    "Using only the existing conversation above as context, produce the exact final plain text the " +
      "user wants on their clipboard, then call clipboard_write with that text. Do not run shell " +
      "commands (no pbcopy/clip/wl-copy), read or edit files, fetch the web, or use any tool other " +
      "than clipboard_write. Reply with a brief confirmation of what you copied.",
  ].join("\n");
}

/** How a `/clip` invocation routes: an immediate no-model copy, or a restricted clipboard turn. */
export type ClipRoute =
  | { readonly kind: "copy" }
  | { readonly kind: "turn"; readonly prompt: string };

/**
 * Routes a `/clip` invocation by its arguments: bare `/clip` (no/blank args) copies the last
 * copyable item immediately with NO model turn; `/clip <request>` starts a restricted clipboard-only
 * turn framed around the request.
 */
export function routeClip(args: string): ClipRoute {
  const request = args.trim();
  if (!request) {
    return { kind: "copy" };
  }
  return { kind: "turn", prompt: buildClipTurnPrompt(request) };
}
