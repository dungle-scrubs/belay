import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveTrevorStateHome } from "@belay/session/node-paths";

export const DEFAULT_VIRTUALIZATION_PERFORMANCE_ARTIFACT_ROOT = join(
  resolveTrevorStateHome(),
  "virtualization-performance/artifacts",
);

export interface VirtualizationPerformanceBudgets {
  readonly bottomDeltaPx: number;
  readonly keyToPaintP95Ms: number;
  readonly mountedRows: number;
  readonly replayToInteractiveMs: number;
}

export interface VirtualizationPerformanceMetrics {
  readonly bottomDeltaPx: number;
  readonly keyToPaintSamplesMs: readonly number[];
  readonly mountedRows: number;
  readonly replayToInteractiveMs: number;
  readonly totalRows: number;
}

export interface VirtualizationPerformanceFailureInput {
  readonly budgets: VirtualizationPerformanceBudgets;
  readonly consoleLines?: readonly string[];
  readonly metrics: VirtualizationPerformanceMetrics;
  readonly screenshotBase64Png?: string;
  readonly sessionId: string;
  readonly trace?: unknown;
  readonly url: string;
}

export type VirtualizationPerformanceArtifactResult =
  | { readonly status: "passed"; readonly failures: readonly string[] }
  | { readonly status: "written"; readonly dir: string; readonly failures: readonly string[] };

export interface WriteVirtualizationPerformanceArtifactsOptions {
  readonly now?: Date;
  readonly rootDir?: string;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function failedBudgets(input: VirtualizationPerformanceFailureInput): string[] {
  const failures: string[] = [];
  const p95 = percentile(input.metrics.keyToPaintSamplesMs, 95);
  if (input.metrics.mountedRows > input.budgets.mountedRows) {
    failures.push(`mountedRows ${input.metrics.mountedRows} > ${input.budgets.mountedRows}`);
  }
  if (p95 > input.budgets.keyToPaintP95Ms) {
    failures.push(`keyToPaintP95Ms ${p95} > ${input.budgets.keyToPaintP95Ms}`);
  }
  if (input.metrics.replayToInteractiveMs > input.budgets.replayToInteractiveMs) {
    failures.push(
      `replayToInteractiveMs ${input.metrics.replayToInteractiveMs} > ${input.budgets.replayToInteractiveMs}`,
    );
  }
  if (input.metrics.bottomDeltaPx > input.budgets.bottomDeltaPx) {
    failures.push(`bottomDeltaPx ${input.metrics.bottomDeltaPx} > ${input.budgets.bottomDeltaPx}`);
  }
  return failures;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function timestampSegment(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export async function writeVirtualizationPerformanceArtifacts(
  input: VirtualizationPerformanceFailureInput,
  options: WriteVirtualizationPerformanceArtifactsOptions = {},
): Promise<VirtualizationPerformanceArtifactResult> {
  const failures = failedBudgets(input);
  if (failures.length === 0) {
    return { status: "passed", failures };
  }

  const now = options.now ?? new Date();
  const rootDir = options.rootDir ?? DEFAULT_VIRTUALIZATION_PERFORMANCE_ARTIFACT_ROOT;
  const dir = join(rootDir, `${timestampSegment(now)}-${input.sessionId}`);
  await mkdir(dir, { recursive: true });

  const summary = {
    budgets: input.budgets,
    failures,
    generatedAt: now.toISOString(),
    sessionId: input.sessionId,
    url: input.url,
  };
  await writeFile(join(dir, "summary.json"), json(summary), "utf8");
  await writeFile(join(dir, "metrics.json"), json(input.metrics), "utf8");
  await writeFile(join(dir, "console.log"), `${(input.consoleLines ?? []).join("\n")}\n`, "utf8");

  if (input.trace !== undefined) {
    await writeFile(join(dir, "performance-trace.json"), json(input.trace), "utf8");
  }
  if (input.screenshotBase64Png) {
    await writeFile(join(dir, "screenshot.png"), Buffer.from(input.screenshotBase64Png, "base64"));
  }

  return { status: "written", dir, failures };
}
