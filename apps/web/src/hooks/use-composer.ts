import type { ArtifactRef } from "@trevor/session";
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
  EMPTY_DRAFT,
  type ImageDraft,
  insertImages,
  removeAdjacentToken,
  syncDraft,
} from "../composer/image-tokens";

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
  // The draft text + its image-token refs as one unit, so they cannot drift.
  const [imageDraft, setImageDraft] = useState<ImageDraft>(EMPTY_DRAFT);
  // Pending NON-image attachments (documents): uploaded refs waiting to ride the next prompt.
  const [attachments, setAttachments] = useState<readonly ArtifactRef[]>([]);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const draft = imageDraft.text;

  // `setDraft` keeps the string API; every text change reconciles the image refs against the new
  // text (surviving tokens keep their numbers, so a deleted token drops the right ref).
  const setDraft: Dispatch<SetStateAction<string>> = (action) => {
    setImageDraft((prev) => {
      const nextText = typeof action === "function" ? action(prev.text) : action;
      return syncDraft(prev, nextText);
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
    setImageDraft((prev) => {
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
          const detail = cause instanceof Error ? cause.message : String(cause);
          setUploadError(`couldn't attach ${file.name || "file"}: ${detail}`);
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
              error: cause instanceof Error ? cause.message : String(cause),
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
  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length) {
      event.preventDefault();
      addFiles(files, caretNow());
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
      imageDraft,
      el.selectionStart,
      event.key === "Backspace" ? -1 : 1,
    );
    if (result) {
      event.preventDefault();
      setImageDraft(result.draft);
      parkCaret(result.cursor);
    }
  };

  const removeAttachment = (hash: string) =>
    setAttachments((a) => a.filter((ref) => ref.hash !== hash));

  return {
    draft,
    setDraft,
    imageRefs: imageDraft.refs,
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
