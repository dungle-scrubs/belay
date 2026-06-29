import { type ArtifactRef, errorMessage, isLargePaste, type PastePayload } from "@trevor/session";
import {
  type ChangeEvent,
  type Dispatch,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type SetStateAction,
  useRef,
  useState,
} from "react";
import { buildQuotedComposerText } from "@/components/assistant-ui/quote";
import { uploadArtifact } from "../blob";
import {
  type ComposerDraft,
  EMPTY_COMPOSER_DRAFT,
  insertImages,
  insertPaste,
  removeAdjacentToken,
  syncComposerDraft,
} from "../composer/draft";

/**
 * The composer's local state as one boundary (D-019 + D-092 image tokens): the draft text WITH its
 * inline `[Image #N]` tokens paired to uploaded image refs (an {@link ImageDraft}), the pending
 * non-image attachments (documents) shown as chips, upload bookkeeping, the textarea + file-input
 * refs, and the file-intake handlers. Image intake inserts a token at the cursor and tracks the ref
 * in reading order; documents keep the chip behavior. App owns submit/steer/slash-menu wiring,
 * reading `draft`/`imageRefs`/`attachments` and clearing them here.
 *
 * `draft`/`setDraft` keep their string API so the slash menu, quote-to-composer, and draft
 * persistence are unchanged; `setDraft` reconciles the image refs against the new text (a raw edit
 * that deletes a token drops the right ref, via the token numbers), so the text and refs never drift.
 */
export interface Composer {
  readonly draft: string;
  readonly setDraft: Dispatch<SetStateAction<string>>;
  /** The image refs paired to the draft's `[Image #N]` tokens, in reading order. */
  readonly imageRefs: readonly ArtifactRef[];
  /** The exact pasted payloads paired to the draft's `[Pasted text #N +M lines]` tokens (D-001). */
  readonly pastes: readonly PastePayload[];
  /** Pending NON-image attachments (documents) shown as chips. */
  readonly attachments: readonly ArtifactRef[];
  readonly setAttachments: Dispatch<SetStateAction<readonly ArtifactRef[]>>;
  /** Count of uploads in flight, so the composer can show progress. */
  readonly uploading: number;
  readonly uploadError: string | null;
  readonly setUploadError: Dispatch<SetStateAction<string | null>>;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly fileInputRef: RefObject<HTMLInputElement | null>;
  readonly onPickFiles: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onPaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  readonly onDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
  /** Backspace/Delete next to a token removes the whole token + its ref in one step. */
  readonly handleKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  readonly removeAttachment: (hash: string) => void;
  readonly quoteSelection: (selected: string) => void;
}

export function useComposer(): Composer {
  // The draft text + its image-token refs AND pasted-text payloads as one unit, so they cannot drift.
  const [composerDraft, setComposerDraft] = useState<ComposerDraft>(EMPTY_COMPOSER_DRAFT);
  // Pending NON-image attachments (documents): uploaded refs waiting to ride the next prompt.
  const [attachments, setAttachments] = useState<readonly ArtifactRef[]>([]);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const draft = composerDraft.text;

  // `setDraft` keeps the string API; every text change reconciles BOTH the image refs and the pasted
  // payloads against the new text (surviving tokens keep their numbers, so a deleted token of either
  // kind drops the right ref/payload).
  const setDraft: Dispatch<SetStateAction<string>> = (action) => {
    setComposerDraft((prev) => {
      const nextText = typeof action === "function" ? action(prev.text) : action;
      return syncComposerDraft(prev, nextText);
    });
  };

  // Parks the caret at `cursor` after a programmatic edit (insert/delete).
  const parkCaret = (cursor: number) => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(cursor, cursor);
      }
    });
  };

  const quoteSelection = (selected: string) => {
    const { value, cursor } = buildQuotedComposerText(draft, selected);
    setDraft(value);
    parkCaret(cursor);
  };

  // Inserts uploaded image tokens at the captured cursor (clamped to the latest text), then parks
  // the caret after them. Deterministic order: the whole batch inserts together.
  const insertUploadedImages = (refs: readonly ArtifactRef[], at: number) => {
    setComposerDraft((prev) => {
      const pos = Math.min(at, prev.text.length);
      const { draft: next, cursor } = insertImages(prev, pos, pos, refs);
      parkCaret(cursor);
      return next;
    });
  };

  // Attachments: an IMAGE becomes an inline `[Image #N]` token at the cursor; a non-image file keeps
  // the document-chip behavior. Uploads run in parallel; a failure simply doesn't attach.
  const addFiles = (files: Iterable<File>, cursorAt: number) => {
    setUploadError(null);
    const list = [...files];
    const images = list.filter((file) => file.type.startsWith("image/"));
    const docs = list.filter((file) => !file.type.startsWith("image/"));

    for (const file of docs) {
      setUploading((n) => n + 1);
      uploadArtifact(file)
        .then((ref) => setAttachments((a) => [...a, ref]))
        .catch((cause: unknown) => {
          setUploadError(`couldn't attach ${file.name || "file"}: ${errorMessage(cause)}`);
        })
        .finally(() => setUploading((n) => n - 1));
    }

    if (images.length > 0) {
      setUploading((n) => n + images.length);
      // Preserve input order despite parallel uploads: collect results positionally, then insert the
      // successful refs as ordered tokens in one go.
      Promise.all(
        images.map((file) =>
          uploadArtifact(file)
            .then((ref) => ({ ref }))
            .catch((cause: unknown) => ({
              error: errorMessage(cause),
            })),
        ),
      )
        .then((results) => {
          const refs = results.flatMap((r) => ("ref" in r ? [r.ref] : []));
          const failed = results.length - refs.length;
          if (failed > 0) {
            setUploadError(`couldn't attach ${failed} image${failed === 1 ? "" : "s"}`);
          }
          if (refs.length > 0) {
            insertUploadedImages(refs, cursorAt);
          }
        })
        .finally(() => setUploading((n) => n - images.length));
    }
  };

  /** The live caret position (where a token should land), or the end of the draft as a fallback. */
  const caretNow = () => inputRef.current?.selectionStart ?? draft.length;

  const onPickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      addFiles(event.target.files, caretNow());
    }
    event.target.value = ""; // let the same file be re-picked
  };
  // Inserts a large pasted-text token at the current selection (paired to the exact payload), parking
  // the caret after it. Reads the live selection so a paste over a selection replaces it.
  const insertPastedText = (text: string) => {
    const el = inputRef.current;
    const selStart = el?.selectionStart ?? draft.length;
    const selEnd = el?.selectionEnd ?? selStart;
    setComposerDraft((prev) => {
      const { draft: next, cursor } = insertPaste(prev, selStart, selEnd, { text });
      parkCaret(cursor);
      return next;
    });
  };

  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    // Files (images/documents) win and route to upload intake, even when the clipboard ALSO carries
    // text, so a copied image is never demoted to a paste token.
    const files = [...event.clipboardData.files];
    if (files.length) {
      event.preventDefault();
      addFiles(files, caretNow());
      return;
    }
    // A large plain-text paste becomes a compact token paired to the exact payload (D-001), so the
    // textarea stays readable. The shell lane is excluded (D-006): pasted command text stays literal
    // there. Small text and any non-text paste fall through to the browser's normal insertion (D-003).
    const text = event.clipboardData.getData("text/plain");
    if (text && !draft.startsWith("!") && isLargePaste(text)) {
      event.preventDefault();
      insertPastedText(text);
    }
  };
  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer.files.length) {
      addFiles(event.dataTransfer.files, caretNow());
    }
  };

  // Backspace/Delete next to a whole token removes the token + its ref atomically (so a token never
  // splits into broken text). When no token is adjacent the textarea handles the key normally.
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Backspace" && event.key !== "Delete") {
      return;
    }
    const el = inputRef.current;
    if (!el || el.selectionStart !== el.selectionEnd) {
      return; // a range selection deletes normally (syncDraft reconciles the refs)
    }
    const result = removeAdjacentToken(
      composerDraft,
      el.selectionStart,
      event.key === "Backspace" ? -1 : 1,
    );
    if (result) {
      event.preventDefault();
      setComposerDraft(result.draft);
      parkCaret(result.cursor);
    }
  };

  const removeAttachment = (hash: string) =>
    setAttachments((a) => a.filter((ref) => ref.hash !== hash));

  return {
    draft,
    setDraft,
    imageRefs: composerDraft.imageRefs,
    pastes: composerDraft.pastes,
    attachments,
    setAttachments,
    uploading,
    uploadError,
    setUploadError,
    inputRef,
    fileInputRef,
    onPickFiles,
    onPaste,
    onDrop,
    handleKeyDown,
    removeAttachment,
    quoteSelection,
  };
}
