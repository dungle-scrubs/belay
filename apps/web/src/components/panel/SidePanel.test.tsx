import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import { SidePanel, SidePanelBreakdown, SidePanelHeader } from "./SidePanel";

test("composes header, breakdown, controls, and footer inside the side drawer", () => {
  const { getByLabelText, getByText } = render(
    <SidePanel
      controls={<button type="button">model control</button>}
      footer={<span>session footer</span>}
    >
      <SidePanelHeader
        title="auth-flow"
        subtitle="session · local"
        workspace="~/dev/trevorV2"
        git={{
          branch: "main",
          detached: null,
          dirty: false,
          ahead: 0,
          behind: 0,
          upstream: true,
          worktree: false,
        }}
      />
      <SidePanelBreakdown ctxUsed={64_000} ctxMax={128_000} totalTokens={4_200} />
    </SidePanel>,
  );

  assert.ok(getByLabelText("session detail"));
  assert.ok(getByText("auth-flow"));
  assert.ok(getByText("session · local"));
  assert.ok(getByText("~/dev/trevorV2"));
  assert.ok(getByText("50%"));
  assert.ok(getByText("4.2k tok"));
  assert.ok(getByText("No turn data yet"));
  assert.ok(getByText("model control"));
  assert.ok(getByText("session footer"));
});
