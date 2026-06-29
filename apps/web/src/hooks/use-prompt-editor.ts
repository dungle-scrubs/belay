import { useCallback, useState } from "react";

/**
 * The full-surface prompt editor's open/close + text state (02.12). Web-local and DOM-free: the
 * PromptSurfaceEditor component owns focus/rendering, App/PanelHost own where it renders.
 *
 * Two callers share one `open` (D-002):
 *   - composer expand: `open({ text: draft, onConfirm: setDraft })` - the user edits the current
 *     draft with room and the edits sync back to the composer on confirm;
 *   - programmatic edit: a caller (02.10 generated-handoff edit) opens with a supplied prompt and
 *     receives the edited text through `onConfirm`.
 *
 * Dismissal always confirms with the current text (back button / Escape / Cmd-Enter), so "close" and
 * "save my edits" are the same gesture - there is no silent-discard path (D-003).
 */
export interface PromptEditorOpenOptions {
  /** The text to seed the editor with. */
  readonly text: string;
  /** Receives the edited text when the editor confirms (back / Escape / Cmd-Enter). */
  readonly onConfirm: (text: string) => void;
  /** Optional header label (e.g. "Edit handoff prompt"); defaults to a generic title. */
  readonly title?: string;
}

export interface PromptEditor {
  readonly isOpen: boolean;
  readonly text: string;
  readonly title: string | undefined;
  readonly setText: (text: string) => void;
  /** Open the editor seeded with `text`; `onConfirm` receives the edited text on confirm. */
  readonly open: (options: PromptEditorOpenOptions) => void;
  /** Hand the current text to the opener's `onConfirm` and close. */
  readonly confirm: () => void;
}

type EditorState =
  | { readonly open: false }
  | {
      readonly open: true;
      readonly text: string;
      readonly title: string | undefined;
      readonly onConfirm: (text: string) => void;
    };

export function usePromptEditor(): PromptEditor {
  const [state, setState] = useState<EditorState>({ open: false });

  const open = useCallback((options: PromptEditorOpenOptions) => {
    setState({
      open: true,
      text: options.text,
      title: options.title,
      onConfirm: options.onConfirm,
    });
  }, []);

  const setText = useCallback((text: string) => {
    setState((prev) => (prev.open ? { ...prev, text } : prev));
  }, []);

  const confirm = useCallback(() => {
    setState((prev) => {
      if (prev.open) {
        prev.onConfirm(prev.text);
      }
      return { open: false };
    });
  }, []);

  return {
    isOpen: state.open,
    text: state.open ? state.text : "",
    title: state.open ? state.title : undefined,
    setText,
    open,
    confirm,
  };
}
