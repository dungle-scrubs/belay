import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { MultiEditDiff } from "@/components/chat/multi-edit-diff";
import { ToolDiff } from "@/components/chat/tool-diff";
import { ToolRenderer } from "@/components/chat/tool-message";
import {
  formatFrameTimestamp,
  parseVideoInspectResult,
  VideoInspectBody,
} from "@/components/chat/video-inspect";
import { cn } from "@/lib/utils";
import type { ToolMessage } from "@/transcript";
import {
  bashDetailArgs,
  editDetailArgs,
  matchCount,
  multiEditDetailArgs,
  readDetailArgs,
  readRangeLabel,
  requestDetailArgs,
  searchDetailArgs,
  toolScriptDetailArgs,
  truncationLabel,
  writeDetailArgs,
} from "../tool-args";
import type { ToolDetailModel } from "./detail-model";

/** How many output lines render before the "N more lines below the fold" advisory (the detail shows
 *  the full output regardless - this only labels how much sits past the first screenful). */
const OUTPUT_FOLD_LINES = 40;

const noop = () => {};

/**
 * The detail body dispatcher (plan 08 M3/M4): given a {@link ToolDetailModel}, render the richest body
 * for that tool, falling back to a generic Arguments/Output body for tools without a bespoke adapter (so
 * an unknown / MCP tool still reads usefully). M3 covers the filesystem + shell tools (bash, read,
 * write, edit, multi_edit); M4 adds the search/web/docs/MCP adapters. The filesystem bodies share the
 * {@link FilePath} primitive (path + open-in-editor) so they can't drift.
 */
export function DetailBody({
  model,
  onOpenPath,
}: {
  readonly model: ToolDetailModel;
  readonly onOpenPath?: (path: string) => void;
}) {
  switch (model.toolName) {
    case "bash":
      return <BashDetail model={model} />;
    case "read":
      return <ReadDetail model={model} onOpenPath={onOpenPath} />;
    case "write":
    case "edit":
      return <DiffDetail model={model} onOpenPath={onOpenPath} />;
    case "multi_edit":
      return <MultiEditDetail model={model} onOpenPath={onOpenPath} />;
    case "grep":
    case "glob":
      return <SearchDetail model={model} />;
    case "web_search":
    case "web_fetch":
    case "docs":
    case "session_recall":
      return <RequestDetail model={model} onOpenPath={onOpenPath} />;
    case "tool_script":
      return <ToolScriptDetail model={model} />;
    case "video_inspect":
      return <VideoInspectDetail model={model} onOpenPath={onOpenPath} />;
    default:
      return <GenericDetail model={model} />;
  }
}

/** Reconstructs the transcript ToolMessage from a detail model, so the detail can reuse the transcript's
 *  own rich result renderers (M4 reuse) instead of re-parsing/re-rendering their results. */
function asToolMessage(model: ToolDetailModel): ToolMessage {
  return {
    kind: "tool",
    id: model.id,
    name: model.toolName,
    args: model.args,
    done: model.status !== "running",
    aborted: model.aborted,
    ...(model.output !== undefined ? { result: model.output } : {}),
  };
}

function SearchDetail({ model }: { readonly model: ToolDetailModel }) {
  const { pattern, path } = searchDetailArgs(model.args);
  const matches = matchCount(model.output, model.status);
  return (
    <>
      <DetailSection title={model.toolName === "glob" ? "Glob" : "Pattern"}>
        <Mono>{pattern || "(none)"}</Mono>
      </DetailSection>
      {path ? (
        <DetailSection title="Scope">
          <Mono>{path}</Mono>
        </DetailSection>
      ) : null}
      {matches !== undefined ? (
        <DetailSection title="Matches">
          <p className="text-xs text-muted-foreground">{matches}</p>
        </DetailSection>
      ) : null}
      <ErrorSection model={model} />
      <OutputSection model={model} title="Results" />
    </>
  );
}

function RequestDetail({
  model,
  onOpenPath,
}: {
  readonly model: ToolDetailModel;
  readonly onOpenPath?: (path: string) => void;
}) {
  const { request, action } = requestDetailArgs(model.args);
  return (
    <>
      <DetailSection title="Request">
        <Mono>{action ? `${action} ${request}` : request || "(none)"}</Mono>
      </DetailSection>
      <ErrorSection model={model} />
      <DetailSection title="Results">
        {/* Reuse the transcript's own rich renderer (search results / fetched source / cited docs /
            recall findings) so the detail is never a poorer view than the row. */}
        <ToolRenderer message={asToolMessage(model)} onOpenPath={onOpenPath ?? noop} />
      </DetailSection>
    </>
  );
}

function BashDetail({ model }: { readonly model: ToolDetailModel }) {
  const { command, cwd } = bashDetailArgs(model.args);
  return (
    <>
      <DetailSection title="Command">
        <Mono>{command || "(none)"}</Mono>
      </DetailSection>
      {cwd ? (
        <DetailSection title="Working directory">
          <Mono>{cwd}</Mono>
        </DetailSection>
      ) : null}
      <ErrorSection model={model} />
      <OutputSection model={model} />
    </>
  );
}

function ToolScriptDetail({ model }: { readonly model: ToolDetailModel }) {
  const { script, toolsets } = toolScriptDetailArgs(model.args);
  return (
    <>
      <DetailSection title="Script">
        <Mono>{script || "(none)"}</Mono>
      </DetailSection>
      <DetailSection title="Permitted toolsets">
        <Mono>{toolsets.length > 0 ? toolsets.join(", ") : "safe_read"}</Mono>
      </DetailSection>
      <ErrorSection model={model} />
      <OutputSection model={model} title="Result" />
    </>
  );
}

function VideoInspectDetail({
  model,
  onOpenPath,
}: {
  readonly model: ToolDetailModel;
  readonly onOpenPath?: (path: string) => void;
}) {
  const parsed = parseVideoInspectResult(model.output);
  const frames = parsed?.frames ?? [];
  return (
    <>
      <DetailSection title="Video">
        <FilePath path={videoDetailPath(model.args)} onOpenPath={onOpenPath} />
      </DetailSection>
      <ErrorSection model={model} />
      {parsed ? (
        <DetailSection title="Frames">
          <VideoInspectBody parsed={parsed} />
        </DetailSection>
      ) : (
        <OutputSection model={model} title="Frames" />
      )}
      {frames.length > 0 ? (
        <DetailSection title="Timeline">
          <div className="flex flex-col divide-y divide-border/70 border-border border-t text-xs">
            {frames.map((frame) => (
              <div key={frame.frameIndex} className="flex items-center gap-3 py-1.5">
                <span className="w-10 shrink-0 text-muted-foreground">#{frame.frameIndex}</span>
                <span className="w-14 shrink-0 font-mono">
                  {formatFrameTimestamp(frame.timestampMs)}
                </span>
                {frame.width !== undefined && frame.height !== undefined ? (
                  <span className="text-muted-foreground">
                    {frame.width}×{frame.height}
                  </span>
                ) : null}
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {frame.artifact ? "stored" : "unavailable"}
                </span>
              </div>
            ))}
          </div>
        </DetailSection>
      ) : null}
    </>
  );
}

/** The inspected video path from the raw args JSON (defensive - the detail never throws on bad args). */
function videoDetailPath(args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    return typeof parsed.path === "string" ? parsed.path : "";
  } catch {
    return "";
  }
}

function ReadDetail({
  model,
  onOpenPath,
}: {
  readonly model: ToolDetailModel;
  readonly onOpenPath?: (path: string) => void;
}) {
  const { path, offset, limit } = readDetailArgs(model.args);
  return (
    <>
      <DetailSection title="File">
        <FilePath path={path} range={readRangeLabel(offset, limit)} onOpenPath={onOpenPath} />
      </DetailSection>
      <ErrorSection model={model} />
      <OutputSection model={model} title="Contents" />
    </>
  );
}

function DiffDetail({
  model,
  onOpenPath,
}: {
  readonly model: ToolDetailModel;
  readonly onOpenPath?: (path: string) => void;
}) {
  // Parse the args once: write/edit embed the full file content / old+new blocks, so re-parsing per
  // field would JSON.parse a large string several times per render.
  const isWrite = model.toolName === "write";
  const write = isWrite ? writeDetailArgs(model.args) : null;
  const edit = isWrite ? null : editDetailArgs(model.args);
  const path = (write ?? edit)?.path ?? "";
  return (
    <>
      <DetailSection title="File">
        <FilePath path={path} onOpenPath={onOpenPath} />
      </DetailSection>
      <DetailSection title={isWrite ? "Contents" : "Change"}>
        {write ? (
          <ToolDiff
            tool="write"
            path={path}
            newText={write.content}
            status={model.status}
            onOpenPath={onOpenPath ? () => onOpenPath(path) : undefined}
          />
        ) : (
          <ToolDiff
            tool="edit"
            path={path}
            oldText={edit?.old}
            newText={edit?.new ?? ""}
            status={model.status}
            onOpenPath={onOpenPath ? () => onOpenPath(path) : undefined}
          />
        )}
      </DetailSection>
      <ErrorSection model={model} />
    </>
  );
}

function MultiEditDetail({
  model,
  onOpenPath,
}: {
  readonly model: ToolDetailModel;
  readonly onOpenPath?: (path: string) => void;
}) {
  const { path, edits } = multiEditDetailArgs(model.args);
  return (
    <>
      <DetailSection title="File">
        <FilePath path={path} onOpenPath={onOpenPath} />
      </DetailSection>
      <DetailSection title={`Changes (${edits.length})`}>
        {edits.length > 0 ? (
          <MultiEditDiff
            edits={edits.map((e) => ({ path, old: e.old, new: e.new }))}
            status={model.status}
            border={false}
            onOpenPath={onOpenPath}
          />
        ) : (
          <p className="text-xs text-muted-foreground">No edits streamed yet.</p>
        )}
      </DetailSection>
      <ErrorSection model={model} />
    </>
  );
}

function GenericDetail({ model }: { readonly model: ToolDetailModel }) {
  return (
    <>
      <DetailSection title="Arguments">
        <Mono>{model.args || "(none)"}</Mono>
      </DetailSection>
      <ErrorSection model={model} />
      <OutputSection model={model} />
    </>
  );
}

/** The shared file primitive every filesystem body uses: the path, an optional line range, and an
 *  open-in-editor action when the surface can open files (M3 REFACTOR - one place, no drift). */
function FilePath({
  path,
  range,
  onOpenPath,
}: {
  readonly path: string;
  readonly range?: string;
  readonly onOpenPath?: (path: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {onOpenPath && path ? (
        <button
          type="button"
          onClick={() => onOpenPath(path)}
          className="flex cursor-pointer items-center gap-1.5 rounded bg-muted px-2 py-1 font-mono text-xs text-foreground hover:text-smui-frost-3"
          title="Open in editor"
        >
          <FileText className="size-3.5" />
          {path || "(none)"}
        </button>
      ) : (
        <Mono>{path || "(none)"}</Mono>
      )}
      {range ? <span className="text-xs text-muted-foreground">{range}</span> : null}
    </div>
  );
}

function OutputSection({
  model,
  title = "Output",
}: {
  readonly model: ToolDetailModel;
  readonly title?: string;
}) {
  const fold = truncationLabel(model.output, OUTPUT_FOLD_LINES);
  return (
    <DetailSection title={title}>
      {model.output ? (
        <>
          <Mono>{model.output}</Mono>
          {fold ? <span className="text-xs text-muted-foreground">{fold}</span> : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {model.status === "running" ? "Running - no output yet." : "No output."}
        </p>
      )}
    </DetailSection>
  );
}

function ErrorSection({ model }: { readonly model: ToolDetailModel }) {
  if (!model.error) {
    return null;
  }
  return (
    <DetailSection title="Error">
      <Mono tone="error">{model.error}</Mono>
    </DetailSection>
  );
}

function DetailSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-label tracking-wider uppercase text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** The shared code/output block: a wrapping monospace pre, muted by default or red for an error. */
function Mono({
  children,
  tone = "muted",
}: {
  readonly children: ReactNode;
  readonly tone?: "muted" | "error";
}) {
  return (
    <pre
      className={cn(
        "overflow-x-auto rounded px-3 py-2 font-mono text-xs whitespace-pre-wrap",
        tone === "error" ? "bg-smui-red/10 text-smui-red" : "bg-muted",
      )}
    >
      {children}
    </pre>
  );
}
