import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { MultiEditDiff } from "@/components/chat/multi-edit-diff";
import { ToolDiff } from "@/components/chat/tool-diff";
import {
  bashDetailArgs,
  editDetailArgs,
  matchCount,
  multiEditDetailArgs,
  readDetailArgs,
  readRangeLabel,
  requestDetailArgs,
  searchDetailArgs,
  truncationLabel,
  writeDetailArgs,
} from "./detail-args";
import type { ToolDetailModel } from "./detail-model";

/** How many output lines render before the "N more lines below the fold" advisory (the detail shows
 *  the full output regardless - this only labels how much sits past the first screenful). */
const OUTPUT_FOLD_LINES = 40;

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
      return <RequestDetail model={model} />;
    default:
      return <GenericDetail model={model} />;
  }
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

function RequestDetail({ model }: { readonly model: ToolDetailModel }) {
  const { request, action } = requestDetailArgs(model.args);
  return (
    <>
      <DetailSection title="Request">
        <Mono>{action ? `${action} ${request}` : request || "(none)"}</Mono>
      </DetailSection>
      <ErrorSection model={model} />
      <OutputSection model={model} title="Results" />
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
  const path =
    model.toolName === "write" ? writeDetailArgs(model.args).path : editDetailArgs(model.args).path;
  return (
    <>
      <DetailSection title="File">
        <FilePath path={path} onOpenPath={onOpenPath} />
      </DetailSection>
      <DetailSection title={model.toolName === "write" ? "Contents" : "Change"}>
        {model.toolName === "write" ? (
          <ToolDiff
            tool="write"
            path={path}
            newText={writeDetailArgs(model.args).content}
            status={model.status}
            onOpenPath={onOpenPath ? () => onOpenPath(path) : undefined}
          />
        ) : (
          <ToolDiff
            tool="edit"
            path={path}
            oldText={editDetailArgs(model.args).old}
            newText={editDetailArgs(model.args).new}
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
export function FilePath({
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
          <pre className="overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
            {model.output}
          </pre>
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
      <pre className="overflow-x-auto rounded bg-smui-red/10 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-smui-red">
        {model.error}
      </pre>
    </DetailSection>
  );
}

export function DetailSection({
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

function Mono({ children }: { readonly children: ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
      {children}
    </pre>
  );
}
