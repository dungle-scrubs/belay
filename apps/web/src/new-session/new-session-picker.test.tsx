import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SupervisorProject } from "@trevor/session";
import { test, vi } from "vitest";
import { NewSessionPicker, type NewSessionPickerProps } from "./new-session-picker";

/**
 * Plan 44.2 M2: the presentational New-session picker. Proves the gating (Create disabled until valid),
 * the recents/folder/path callbacks, the folder-icon local-vs-remote gate, and the locked-controls
 * "starting host…" state - all over injected props, no live supervisor.
 */

const NOW = Date.parse("2026-07-04T12:00:00.000Z");

const RECENTS: SupervisorProject[] = [
  { root: "~/dev/trevor", sessionId: "s1", updatedAt: "2026-07-04T11:00:00.000Z" },
  { root: "~/dev/opchain", sessionId: "s2", updatedAt: "2026-07-03T12:00:00.000Z" },
];

function renderPicker(over: Partial<NewSessionPickerProps> = {}) {
  const props: NewSessionPickerProps = {
    open: true,
    onOpenChange: vi.fn(),
    recents: RECENTS,
    path: "",
    validation: "empty",
    localPickerAvailable: true,
    launchState: "idle",
    error: null,
    onPickRecent: vi.fn(),
    onPickFolder: vi.fn(),
    onPathChange: vi.fn(),
    onCreate: vi.fn(),
    nowMs: NOW,
    ...over,
  };
  render(<NewSessionPicker {...props} />);
  return props;
}

const createButton = () => screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;

test("renders recents and picking one launches that root directly", () => {
  const props = renderPicker();
  assert.ok(screen.getByText("trevor"), "the recent's folder name renders");
  assert.ok(screen.getByText("~/dev/opchain"), "the recent's full root renders");
  fireEvent.click(screen.getByText("trevor"));
  assert.deepEqual((props.onPickRecent as ReturnType<typeof vi.fn>).mock.calls, [["~/dev/trevor"]]);
});

test("empty recents shows the no-recents state", () => {
  renderPicker({ recents: [] });
  assert.ok(screen.getByText("No recent projects yet."));
});

test("Create is disabled while the path is empty or invalid, enabled when valid", () => {
  const { rerender } = render(
    <NewSessionPicker
      open
      onOpenChange={vi.fn()}
      recents={RECENTS}
      path=""
      validation="empty"
      localPickerAvailable
      launchState="idle"
      onPickRecent={vi.fn()}
      onPickFolder={vi.fn()}
      onPathChange={vi.fn()}
      onCreate={vi.fn()}
      nowMs={NOW}
    />,
  );
  assert.equal(createButton().disabled, true, "empty path disables Create");

  rerender(
    <NewSessionPicker
      open
      onOpenChange={vi.fn()}
      recents={RECENTS}
      path="not-a-path"
      validation="invalid"
      localPickerAvailable
      launchState="idle"
      onPickRecent={vi.fn()}
      onPickFolder={vi.fn()}
      onPathChange={vi.fn()}
      onCreate={vi.fn()}
      nowMs={NOW}
    />,
  );
  assert.equal(createButton().disabled, true, "invalid path disables Create");
  const input = screen.getByLabelText("Folder") as HTMLInputElement;
  assert.equal(input.getAttribute("aria-invalid"), "true", "invalid path marks the field");

  rerender(
    <NewSessionPicker
      open
      onOpenChange={vi.fn()}
      recents={RECENTS}
      path="~/dev/new-thing"
      validation="valid"
      localPickerAvailable
      launchState="idle"
      onPickRecent={vi.fn()}
      onPickFolder={vi.fn()}
      onPathChange={vi.fn()}
      onCreate={vi.fn()}
      nowMs={NOW}
    />,
  );
  assert.equal(createButton().disabled, false, "a valid path enables Create");
});

test("Create launches the typed path", () => {
  const props = renderPicker({ path: "~/dev/new-thing", validation: "valid" });
  fireEvent.click(createButton());
  assert.deepEqual((props.onCreate as ReturnType<typeof vi.fn>).mock.calls, [["~/dev/new-thing"]]);
});

test("typing in the path field reports the change", () => {
  const props = renderPicker();
  fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/tmp/x" } });
  assert.deepEqual((props.onPathChange as ReturnType<typeof vi.fn>).mock.calls, [["/tmp/x"]]);
});

test("the native folder icon shows only when a local picker is available, and pops the picker", () => {
  const props = renderPicker({ localPickerAvailable: true });
  fireEvent.click(screen.getByLabelText("Browse for a folder"));
  assert.equal((props.onPickFolder as ReturnType<typeof vi.fn>).mock.calls.length, 1);
});

test("the native folder icon is hidden for a remote/headless backend", () => {
  renderPicker({ localPickerAvailable: false });
  assert.equal(screen.queryByLabelText("Browse for a folder"), null);
});

test("the starting-host state locks every control and swaps Create in place", () => {
  const props = renderPicker({
    path: "~/dev/new-thing",
    validation: "valid",
    launchState: "starting",
  });
  // The footer shows the starting indicator instead of a Create button.
  assert.ok(screen.getByText("Starting host…"), "the in-place starting indicator shows");
  assert.equal(screen.queryByRole("button", { name: "Create" }), null, "Create is swapped out");
  // The path field and the folder icon are locked.
  assert.equal((screen.getByLabelText("Folder") as HTMLInputElement).disabled, true);
  assert.equal((screen.getByLabelText("Browse for a folder") as HTMLButtonElement).disabled, true);
  // A recent cannot launch while starting (its button is disabled).
  const recentBtn = screen.getByText("trevor").closest("button") as HTMLButtonElement;
  assert.equal(recentBtn.disabled, true);
  fireEvent.click(recentBtn);
  assert.equal((props.onPickRecent as ReturnType<typeof vi.fn>).mock.calls.length, 0);
});

test("a launch error surfaces inline", () => {
  renderPicker({ error: "no local supervisor available" });
  assert.ok(screen.getByText("no local supervisor available"));
});

test("a failed launch swaps Create for a Retry that re-launches, error beside it", () => {
  const onRetry = vi.fn();
  renderPicker({
    path: "~/dev/new-thing",
    validation: "valid",
    launchState: "failed",
    error: "no local supervisor available",
    onRetry,
  });
  assert.ok(screen.getByText("no local supervisor available"), "the named error surfaces");
  assert.equal(screen.queryByRole("button", { name: "Create" }), null, "Create is swapped out");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  assert.equal((onRetry as ReturnType<typeof vi.fn>).mock.calls.length, 1, "Retry re-launches");
  // Recovery locks the controls: Retry is the one way out (a fresh Create would double-launch).
  assert.equal((screen.getByLabelText("Folder") as HTMLInputElement).disabled, true);
});
