import type { ArtifactRef } from "@trevor/session";
import {
  type ChangeEvent,
  type Dispatch,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type RefObject,
  type SetStateAction,
  useRef,
  useState,
} from "react";
import { buildQuotedComposerText } from "@/components/assistant-ui/quote";
import { uploadArtifact } from "../blob";

/**
 * The composer's local state as one boundary (D-019): the draft text, the pending attachments and
 * their upload bookkeeping, the textarea + file-input refs, and the file-intake handlers (pick / paste
 * / drop) plus quote-to-composer. App owns submit/steer/slash-menu wiring (those depend on the send
 * queue, the host command list, and the model), reading `draft`/`attachments` and clearing them here;
 * everything that is purely "what's in the composer right now" lives in this hook instead of as a
 * dozen loose declarations on the App shell.
 */
export interface Composer {
  readonly draft: string;
  readonly setDraft: Dispatch<SetStateAction<string>>;
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
  readonly removeAttachment: (hash: string) => void;
  readonly quoteSelection: (selected: string) => void;
}

export function useComposer(): Composer {
  const [draft, setDraft] = useState("");
  // Pending attachments: ArtifactRefs already uploaded to the blob store, waiting to ride the next
  // prompt. `uploading` counts in-flight uploads so the composer can show progress.
  const [attachments, setAttachments] = useState<readonly ArtifactRef[]>([]);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Quote a highlighted message into the composer: append it as a markdown blockquote below the
  // current draft, then focus the input and park the cursor on the fresh line beneath it
  // (GitHub-style). Driven by QuoteSelectionToolbar's selection detection.
  const quoteSelection = (selected: string) => {
    const { value, cursor } = buildQuotedComposerText(draft, selected);
    setDraft(value);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input) {
        input.focus();
        input.setSelectionRange(cursor, cursor);
      }
    });
  };

  // Attachments: upload each picked/pasted/dropped file to the blob store and hold its ArtifactRef
  // until the next prompt carries it. Uploads run in parallel; a failed one simply doesn't attach.
  // `uploading` brackets each so the composer can show progress.
  const addFiles = (files: Iterable<File>) => {
    setUploadError(null);
    for (const file of files) {
      setUploading((n) => n + 1);
      uploadArtifact(file)
        .then((ref) => setAttachments((a) => [...a, ref]))
        .catch((cause: unknown) => {
          const detail = cause instanceof Error ? cause.message : String(cause);
          setUploadError(`couldn't attach ${file.name || "file"}: ${detail}`);
        })
        .finally(() => setUploading((n) => n - 1));
    }
  };
  const onPickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      addFiles(event.target.files);
    }
    event.target.value = ""; // let the same file be re-picked
  };
  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length) {
      event.preventDefault();
      addFiles(files);
    }
  };
  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer.files.length) {
      addFiles(event.dataTransfer.files);
    }
  };
  const removeAttachment = (hash: string) =>
    setAttachments((a) => a.filter((ref) => ref.hash !== hash));

  return {
    draft,
    setDraft,
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
    removeAttachment,
    quoteSelection,
  };
}
