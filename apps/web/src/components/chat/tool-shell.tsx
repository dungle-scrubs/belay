import type { ReactNode } from "react";
import { ToolCall, type ToolStatus } from "./message";
import { ToolSection } from "./tool-section";

/**
 * The shared `ToolCall + (border ? ToolSection : flat)` assembly every result-bearing
 * tool renderer (diff, output, web-search) builds on, so the wrapper is written once.
 * Each renderer supplies its `flat` and `bordered` bodies (they genuinely differ - a
 * flat body sits directly under the row; the bordered one rides in a ToolSection box),
 * and ToolShell picks between them. Body-less rows skip this and render `<ToolCall>` bare.
 */
export interface ToolShellProps {
  name: string;
  args?: ReactNode;
  status?: ToolStatus;
  /** Whether the body starts expanded; the global compact setting drives this. */
  defaultOpen?: boolean;
  className?: string;
  /** When set, the args text becomes a click target that opens the file in the editor. */
  onOpenPath?: () => void;
  /**
   * Draw the body inside a bordered ToolSection box. Off by default for single-section
   * tools: a lone body sits flat under the already-collapsible tool row, so the box (and
   * its second chevron) would be redundant. This is the seam to box it when wanted.
   */
  border?: boolean;
  /** Header left/right of the ToolSection box (e.g. a file path, a +/- stat or meta line). */
  sectionTitle?: ReactNode;
  sectionMeta?: ReactNode;
  /** Body shown when `border` is false - directly under the tool row. */
  flat: ReactNode;
  /** Body shown when `border` is true - wrapped in the ToolSection box. */
  bordered: ReactNode;
}

export function ToolShell({
  name,
  args,
  status,
  defaultOpen,
  className,
  onOpenPath,
  border = false,
  sectionTitle,
  sectionMeta,
  flat,
  bordered,
}: ToolShellProps) {
  return (
    <ToolCall
      name={name}
      args={args}
      status={status}
      defaultOpen={defaultOpen}
      className={className}
      onOpenPath={onOpenPath}
    >
      {border ? (
        <ToolSection title={sectionTitle} meta={sectionMeta}>
          {bordered}
        </ToolSection>
      ) : (
        flat
      )}
    </ToolCall>
  );
}
