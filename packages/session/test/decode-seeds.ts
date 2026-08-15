/**
 * Realistic per-wire-type seed payloads for the protocol decode differential test.
 * Each entry mirrors what the emit-side constructor in ../src/protocol/events.ts
 * actually produces (same key spelling, same nesting); `variants` covers meaningfully
 * different shapes (all optionals present vs minimal, ok vs error paths, etc.).
 */
export interface DecodeSeed {
  readonly type: string;
  readonly variants: readonly Record<string, unknown>[];
}

// Two distinct sha256 hex digests (HEX64), reused across artifact/lucid seed payloads.
const HASH_1 = "b1eb2583a6939529a6fe963edea06fbbccff64a3a4926570e921766be28e1d9f";
const HASH_2 = "ed09bcfddeef53b68947808889d31b7bee939d218a15ce74fee7684dd866f83a";
const HASH_3 = "723418eee18fa763d68d0d18160f10def5d461fa06660e567c28c8a072fbc428";
const HASH_4 = "810818309c39f6c2ea0862e9de10a1a92eb7f7e1ea325ba0b90e3ad1a42f5d69";

export const DECODE_SEEDS: readonly DecodeSeed[] = [
  // --- transcript family ---
  {
    type: "user.message",
    variants: [
      {
        text: "Please refactor the auth module and add tests.",
        provider: "anthropic",
        reasoning: "high",
        model: { sourceId: "anthropic", modelId: "claude-sonnet-5", reasoning: "high" },
        artifacts: [
          {
            kind: "image",
            mimeType: "image/png",
            size: 48213,
            hash: HASH_1,
            name: "screenshot.png",
          },
          {
            kind: "document",
            mimeType: "text/html",
            size: 2048,
            hash: HASH_2,
            name: "plan.html",
            lucid: {
              lucidId: "lucid_1",
              version: 2,
              provenance: "agent",
              reviewStatus: "open",
              title: "Plan",
            },
          },
        ],
        pastes: [{ text: "line one\nline two\nline three" }],
      },
      { text: "fix the bug" },
    ],
  },
  {
    type: "assistant.started",
    variants: [
      { runId: "run_1", warm: true, model: "claude-sonnet-5", provider: "anthropic" },
      { runId: "run_2", warm: false, model: "claude-sonnet-5" },
    ],
  },
  {
    type: "assistant.delta",
    variants: [
      { runId: "run_1", text: "Here's the plan: " },
      { runId: "run_1", text: "" },
    ],
  },
  {
    type: "assistant.thinking",
    variants: [
      { runId: "run_1", text: "Considering the tradeoffs..." },
      { runId: "run_1", text: "" },
    ],
  },
  {
    type: "assistant.overflow",
    variants: [
      { runId: "run_1", reason: "context window exceeded during tool loop" },
      { runId: "run_1" },
    ],
  },
  {
    type: "assistant.recovered",
    variants: [
      { runId: "run_1", action: "trim", detail: "trimmed 3 stale tool results", reclaimed: 4200 },
      {
        runId: "run_1",
        action: "reduce-thinking",
        detail: "reduced thinking budget",
        reclaimed: 1800,
      },
      { runId: "run_1", action: "trim", detail: "", reclaimed: 0 },
    ],
  },
  {
    type: "assistant.continued",
    variants: [
      {
        runId: "run_1",
        steps: 42,
        pressure: 0.83,
        threshold: 50,
        detail: "continuing past step checkpoint",
      },
      { runId: "run_1", steps: 0, pressure: 0, threshold: 0, detail: "" },
    ],
  },
  {
    type: "assistant.reconnecting",
    variants: [
      {
        runId: "run_1",
        attempt: 2,
        maxAttempts: 3,
        detail: "stream dropped, retrying",
        diagnostic: {
          provider: "anthropic",
          model: "claude-sonnet-5",
          phase: "stream",
          reason: "transport_loss",
          retryable: true,
          safeToRetry: true,
          attempt: 2,
          detail: "connection reset",
          partials: { textChars: 120, thinkingChars: 40, toolCalls: 1, toolResults: 0 },
          status: 529,
          code: "overloaded_error",
          requestId: "req_abc123",
        },
      },
      { runId: "run_1", attempt: 1, detail: "reconnecting" },
    ],
  },
  {
    type: "assistant.limit",
    variants: [
      {
        provider: "anthropic",
        status: "approaching",
        scope: "five_hour",
        resetsAt: 1730000000,
        utilization: 0.82,
      },
      { provider: "openai", status: "reached", scope: "seven_day" },
      { provider: "anthropic", status: "ok", scope: "unified" },
    ],
  },
  {
    type: "model.switched",
    variants: [
      {
        runId: "run_1",
        from: { model: "claude-sonnet-5", reasoning: "medium" },
        to: { model: "claude-opus-4.8", reasoning: "high" },
        initiator: "manual",
        outcome: "applied",
      },
      {
        runId: "run_1",
        from: { model: "claude-sonnet-5" },
        to: { model: "claude-haiku" },
        initiator: "auto",
        outcome: "blocked",
        reason: "target context window smaller than in-flight prompt",
      },
      {
        runId: "run_1",
        from: { model: "m1" },
        to: { model: "m2" },
        initiator: "manual",
        outcome: "applied",
      },
    ],
  },
  {
    type: "model.switch.requested",
    variants: [
      {
        runId: "run_1",
        model: { sourceId: "anthropic", modelId: "claude-opus-4.8", reasoning: "high" },
        initiator: "manual",
      },
      { runId: "run_1", initiator: "auto" },
    ],
  },
  {
    type: "delegated.to",
    variants: [
      {
        runId: "run_1",
        childSessionId: "sess_child_1",
        agent: "code-reviewer",
        task: "Review the auth diff",
        mode: "inline",
        model: "claude-opus-4.8",
        status: "done",
        result: "Found two issues.",
        reasoningLevel: "high",
        tokens: 15230,
      },
      {
        runId: "run_1",
        childSessionId: "sess_child_2",
        agent: "general-purpose",
        task: "Investigate flaky test",
        mode: "background",
        status: "running",
      },
      {
        runId: "run_1",
        childSessionId: "sess_child_3",
        agent: "workflow-leaf",
        task: "leaf task",
        mode: "inline",
        status: "interrupted",
      },
    ],
  },
  {
    type: "workflow.started",
    variants: [
      { runId: "run_1", workflow: "release", args: { version: "1.4.0", dryRun: false } },
      { runId: "run_1", workflow: "release" },
    ],
  },
  {
    type: "workflow.phase",
    variants: [
      { runId: "run_1", title: "Running verification gate" },
      { runId: "run_1", title: "" },
    ],
  },
  {
    type: "workflow.agent",
    variants: [
      {
        runId: "run_1",
        ordinal: [2, 1],
        fingerprint: "leaf-2-1:abcd1234",
        status: "completed",
        usage: { input: 1200, output: 340 },
        result: { ok: true, summary: "Implemented the fix" },
      },
      {
        runId: "run_1",
        ordinal: [1],
        fingerprint: "leaf-1:ffff0000",
        status: "replayed",
        usage: { input: 0, output: 0 },
        result: null,
      },
    ],
  },
  {
    type: "workflow.leaf-failed",
    variants: [
      {
        runId: "run_1",
        kind: "delegate_inline",
        cause: "tool_error",
        childSessionId: "sess_child_9",
        detail: { message: "timeout after 120s" },
      },
      { runId: "run_1", kind: "delegate_inline", cause: "unknown", childSessionId: "sess_child_9" },
    ],
  },
  {
    type: "workflow.log",
    variants: [
      { runId: "run_1", message: "Phase 2 of 4 complete" },
      { runId: "run_1", message: "" },
    ],
  },
  {
    type: "workflow.completed",
    variants: [
      { runId: "run_1", ok: true, leaves: 6 },
      { runId: "run_1", ok: false, leaves: 2 },
    ],
  },
  {
    type: "assistant.progress",
    variants: [
      {
        runId: "run_1",
        usage: { input: 12000, output: 340, contextWindow: 200000, genMs: 1450 },
        breakdown: {
          input: {
            systemAndTools: 4200,
            userText: 800,
            assistantText: 3000,
            toolCallArgs: 600,
            toolResults: 3400,
            imagesBase64: 0,
            imageCount: 0,
            byTool: { Read: 2000, Bash: 1400 },
          },
          output: { thinking: 1200, answer: 800, toolCallArgs: 0 },
        },
      },
      { runId: "run_1", usage: { input: 0, output: 0, contextWindow: 0, genMs: 0 } },
    ],
  },
  {
    type: "assistant.completed",
    variants: [
      {
        runId: "run_1",
        text: "Done - tests pass.",
        usage: { input: 15000, output: 900, contextWindow: 200000, genMs: 2200 },
        breakdown: {
          input: {
            systemAndTools: 4200,
            userText: 800,
            assistantText: 3000,
            toolCallArgs: 600,
            toolResults: 6400,
            imagesBase64: 0,
            imageCount: 0,
            byTool: { Read: 4000, Bash: 2400 },
          },
          output: { thinking: 400, answer: 500, toolCallArgs: 0 },
        },
        stop: {
          cause: "answered",
          action: "completed",
          summary: "Turn completed normally.",
          steps: 12,
          context: { inputTokens: 15000, contextWindow: 200000, pressure: 0.075 },
          diagnosticRef: null,
        },
      },
      {
        runId: "run_1",
        text: "",
        error: "provider_overloaded",
        cancelled: true,
        stop: {
          cause: "error",
          action: "failed",
          summary: "Provider overloaded.",
          diagnosticRef: "diag_1",
        },
        diagnostic: {
          provider: "anthropic",
          phase: "model-step",
          reason: "provider_overloaded",
          retryable: true,
          safeToRetry: false,
          attempt: 3,
          detail: "529 from provider",
          partials: { textChars: 0, thinkingChars: 0, toolCalls: 0, toolResults: 0 },
          status: 529,
        },
      },
      { runId: "run_1", text: "ok" },
    ],
  },
  {
    type: "context.compacted",
    variants: [
      {
        foldId: "fold_2",
        throughSeq: 340,
        supersedes: "fold_1",
        summary: "Folded turns 200-340 covering the auth refactor.",
        manifest: {
          turnRange: { fromSeq: 200, toSeq: 340 },
          files: ["src/auth.ts", "src/session.ts"],
          tools: ["Read", "Edit"],
          topics: ["auth", "session"],
        },
        tokensBefore: 180000,
        tokensAfter: 60000,
        model: "claude-sonnet-5",
      },
      {
        foldId: "fold_1",
        throughSeq: 10,
        summary: "",
        manifest: { turnRange: { fromSeq: 0, toSeq: 10 }, files: [], tools: [], topics: [] },
        tokensBefore: 0,
        tokensAfter: 0,
        model: "claude-sonnet-5",
      },
    ],
  },
  {
    type: "context.compacting",
    variants: [
      { foldId: "fold_2", tokens: 4200, budget: 8000 },
      { foldId: "fold_2", tokens: 0, budget: 0 },
    ],
  },

  // --- user control family ---
  {
    type: "user.cancel",
    variants: [{ runId: "run_1", steered: true }, { runId: "run_1" }],
  },
  {
    type: "user.supersede",
    variants: [
      { supersedes: ["evt_1", "evt_2"], reason: "fold" },
      { supersedes: ["evt_3"], reason: "recall" },
      { supersedes: [], reason: "unqueue" },
    ],
  },
  {
    type: "user.command",
    variants: [
      { command: "/shell", args: "git status" },
      { command: "/clear", args: "" },
    ],
  },
  {
    type: "command.result",
    variants: [
      {
        command: "/style",
        text: "Choose an output style",
        ok: true,
        menu: {
          family: "style",
          title: "Output style",
          searchable: true,
          emptyText: "No styles found",
          rows: [
            {
              id: "concise",
              label: "Concise",
              description: "Short, to the point",
              selected: true,
              badge: "active",
            },
            {
              id: "more",
              label: "More styles",
              children: [
                { id: "verbose", label: "Verbose", disabledReason: "not available on this plan" },
              ],
            },
          ],
        },
        focusSessionId: "sess_focus_1",
      },
      { command: "/clear", text: "Cleared.", ok: true },
    ],
  },
  {
    type: "user.shell",
    variants: [
      { requestId: "req_shell_1", command: "ls -la" },
      { requestId: "req_shell_1", command: "" },
    ],
  },
  {
    type: "shell.result",
    variants: [
      {
        requestId: "req_shell_1",
        command: "ls -la",
        output: "total 24\ndrwxr-xr-x  5 kevin  staff  160 Jul 10 12:00 .",
        ok: true,
      },
      {
        requestId: "req_shell_2",
        command: "rm -rf /",
        output: "refused: destructive command",
        ok: false,
      },
    ],
  },
  {
    type: "editor.open",
    variants: [
      { path: "/Users/kevin/dev/belay/src/index.ts", line: 42, column: 8 },
      { path: "/Users/kevin/dev/belay/README.md" },
    ],
  },

  // --- session family ---
  {
    type: "session.switch",
    variants: [
      { sessionId: "sess_2", reason: "worktree" },
      { sessionId: "sess_3", reason: "handoff" },
      { sessionId: "sess_1", reason: "clear" },
    ],
  },
  {
    type: "session.archived",
    variants: [{ archived: true }, { archived: false }],
  },
  {
    type: "session.title",
    variants: [{ title: "Refactor auth module" }, { title: "" }],
  },
  {
    type: "session.deleted",
    variants: [{ deleted: true }, { deleted: false }],
  },
  {
    type: "session.forkedFrom",
    variants: [
      { parentSessionId: "sess_parent_1", forkSeq: 128 },
      { parentSessionId: "sess_parent_1", forkSeq: 0 },
    ],
  },
  {
    type: "session.tangentOf",
    variants: [
      {
        parentSessionId: "sess_parent_1",
        sourceMessageId: "evt_42",
        quote: "Consider caching the catalog lookups.",
        label: "Catalog caching tangent",
      },
      { parentSessionId: "sess_parent_1", sourceMessageId: "evt_42", quote: "" },
    ],
  },
  {
    type: "session.project",
    variants: [{ path: "/Users/kevin/dev/belay" }, { path: "" }],
  },
  {
    type: "session.worktree",
    variants: [
      {
        id: "wt_1",
        branch: "feature/auth-refactor",
        path: "/Users/kevin/dev/belay/.worktrees/feature-auth-refactor",
      },
      { id: "", branch: "", path: "" },
    ],
  },
  {
    type: "tangent.foldedBack",
    variants: [
      {
        tangentSessionId: "sess_tangent_1",
        parentSessionId: "sess_parent_1",
        mode: "summary",
        preview: "Explored caching, recommend LRU with a 5 minute TTL.",
      },
      {
        tangentSessionId: "sess_tangent_2",
        parentSessionId: "sess_parent_1",
        mode: "quote",
        preview: "Use an LRU cache.",
      },
      {
        tangentSessionId: "sess_tangent_1",
        parentSessionId: "sess_parent_1",
        mode: "message",
        preview: "",
      },
    ],
  },
  {
    type: "tangent.created",
    variants: [
      { tangentSessionId: "sess_tangent_1", sourceMessageId: "evt_42" },
      { tangentSessionId: "", sourceMessageId: "" },
    ],
  },
  {
    type: "file.index.requested",
    variants: [{ requestId: "req_idx_1" }, {}],
  },
  {
    type: "file.index.result",
    variants: [
      {
        requestId: "req_idx_1",
        files: ["src/index.ts", "src/protocol/events.ts", "packages/session/test/decode-seeds.ts"],
        truncated: false,
      },
      { requestId: "req_idx_1", files: [], truncated: true },
    ],
  },
  {
    type: "session.launch.requested",
    variants: [
      {
        requestId: "req_launch_1",
        root: "/Users/kevin/dev/belay",
        sessionId: "sess_fresh_1",
        projectPath: "/Users/kevin/dev/belay",
      },
      { requestId: "req_launch_1", root: "/Users/kevin/dev/belay" },
    ],
  },
  {
    type: "session.launch.result",
    variants: [
      {
        requestId: "req_launch_1",
        sessionId: "",
        status: "failed",
        error: "could not spawn host process",
      },
      { requestId: "req_launch_1", sessionId: "sess_fresh_1", status: "launched" },
      { requestId: "req_launch_1", sessionId: "sess_existing_1", status: "reused" },
    ],
  },
  {
    type: "folder.pick.requested",
    variants: [{ requestId: "req_folder_1" }, {}],
  },
  {
    type: "folder.pick.result",
    variants: [
      { requestId: "req_folder_1", path: "/Users/kevin/dev/newproject", cancelled: false },
      { requestId: "req_folder_1", cancelled: true },
    ],
  },
  {
    type: "projects.list.requested",
    variants: [{ requestId: "req_projects_1" }, {}],
  },
  {
    type: "projects.list.result",
    variants: [
      {
        requestId: "req_projects_1",
        projects: [
          {
            root: "/Users/kevin/dev/belay",
            sessionId: "sess_belay_1",
            updatedAt: "2026-07-09T10:00:00.000Z",
            missing: false,
            displayPath: "~/dev/belay",
            displayName: "Belay",
            collapsed: true,
            createdAt: "2026-07-01T09:00:00.000Z",
          },
          {
            root: "/Users/kevin/dev/opchain",
            sessionId: "sess_opchain_1",
            updatedAt: "2026-07-08T15:30:00.000Z",
            missing: true,
          },
          {
            root: "/Users/kevin/dev/legacy",
            sessionId: "sess_legacy_1",
            updatedAt: "2026-07-07T15:30:00.000Z",
          },
        ],
      },
      { requestId: "req_projects_1", projects: [] },
    ],
  },
  {
    type: "project.add.requested",
    variants: [{ requestId: "req_add_1" }, {}],
  },
  {
    type: "project.add.result",
    variants: [
      {
        requestId: "req_add_1",
        path: "/Users/kevin/dev/newproj",
        displayName: "New Project",
        cancelled: false,
      },
      { requestId: "req_add_1", cancelled: true },
      { requestId: "req_add_1", cancelled: false, error: "path already registered" },
    ],
  },
  {
    type: "project.rename.requested",
    variants: [
      { requestId: "req_rename_1", path: "/Users/kevin/dev/belay", displayName: "Belay" },
      { requestId: "req_rename_1", path: "/Users/kevin/dev/belay", displayName: "" },
    ],
  },
  {
    type: "project.rename.result",
    variants: [
      { requestId: "req_rename_1", path: "/Users/kevin/dev/belay", displayName: "Belay" },
      { requestId: "req_rename_1", error: "project not found" },
    ],
  },
  {
    type: "project.collapse.requested",
    variants: [
      { requestId: "req_collapse_1", path: "/Users/kevin/dev/belay", collapsed: true },
      { requestId: "req_collapse_1", path: "/Users/kevin/dev/belay", collapsed: false },
    ],
  },
  {
    type: "project.collapse.result",
    variants: [
      { requestId: "req_collapse_1", path: "/Users/kevin/dev/belay", collapsed: true },
      { requestId: "req_collapse_1", collapsed: false, error: "project not found" },
    ],
  },
  {
    type: "project.remove.requested",
    variants: [
      { requestId: "req_remove_1", path: "/Users/kevin/dev/belay" },
      { requestId: "req_remove_1", path: "" },
    ],
  },
  {
    type: "project.remove.result",
    variants: [
      {
        requestId: "req_remove_1",
        path: "/Users/kevin/dev/belay",
        removed: false,
        blockedBy: ["sess_belay_1", "sess_belay_2"],
      },
      { requestId: "req_remove_1", path: "/Users/kevin/dev/belay", removed: true },
      { requestId: "req_remove_1", removed: false, error: "path not registered" },
    ],
  },

  // --- lucid family ---
  {
    type: "lucid.published",
    variants: [
      {
        lucidId: "lucid_1",
        version: 3,
        htmlHash: HASH_3,
        provenance: "agent",
        title: "Auth Flow Diagram",
      },
      { lucidId: "lucid_2", version: 1, htmlHash: HASH_4, provenance: "external" },
      { lucidId: "lucid_1", version: 1, htmlHash: HASH_3, provenance: "import" },
    ],
  },
  {
    type: "lucid.feedback",
    variants: [
      {
        lucidId: "lucid_1",
        version: 3,
        cursor: 5,
        annotations: [
          {
            annotationId: "ann_1",
            anchor: {
              type: "element",
              lucidId: "node-42",
              fingerprint: "h1:Auth Flow",
              domPath: "body>div:nth-child(2)>h1",
            },
            snippet: "Auth Flow",
            note: "Rename this heading to 'Authentication Flow'.",
            orphaned: false,
            resolved: false,
          },
          {
            annotationId: "ann_2",
            anchor: {
              type: "range",
              quote: "the token expires",
              prefix: "Note that ",
              suffix: " after 15 minutes",
              start: 120,
              end: 138,
            },
            snippet: "the token expires",
            note: "Clarify which token.",
            resolved: true,
          },
        ],
        message: "Overall looks good, two small notes.",
      },
      { lucidId: "lucid_1", version: 1, cursor: 0, annotations: [] },
    ],
  },
  {
    type: "lucid.review",
    variants: [
      { lucidId: "lucid_1", resolved: true, cursor: 5 },
      { lucidId: "lucid_1", resolved: false, cursor: 0 },
    ],
  },

  // --- host family ---
  {
    type: "tasks.current",
    variants: [
      {
        tasks: [
          {
            id: "task_1",
            subject: "Write decode seeds",
            activeForm: "Writing decode seeds",
            status: "in_progress",
            blockedBy: [],
            blocks: ["task_2"],
          },
          {
            id: "task_2",
            subject: "Run typecheck",
            activeForm: "Running typecheck",
            status: "pending",
            blockedBy: ["task_1"],
            blocks: [],
          },
        ],
        rev: 7,
      },
      { tasks: [] },
    ],
  },
  {
    type: "tool.started",
    variants: [
      {
        runId: "run_1",
        callId: "call_1",
        name: "Read",
        arguments: '{"file_path":"/Users/kevin/dev/belay/README.md"}',
      },
      { runId: "run_1", callId: "call_1", name: "Bash", arguments: "" },
    ],
  },
  {
    type: "tool.completed",
    variants: [
      { runId: "run_1", callId: "call_1", name: "Read", result: "file contents here" },
      { runId: "run_1", callId: "call_1", name: "Bash", result: "" },
    ],
  },
  {
    type: "tool.guardrail",
    variants: [
      {
        runId: "run_1",
        callId: "call_2",
        name: "Bash",
        action: "block",
        reason: "repeated_failure",
        count: 3,
        argsFingerprint: "fp_args_1",
        resultFingerprint: "fp_result_1",
        failureFingerprint: "fp_fail_1",
      },
      {
        runId: "run_1",
        callId: "call_2",
        name: "Bash",
        action: "warn",
        reason: "no_progress",
        count: 1,
        argsFingerprint: "fp_args_1",
      },
    ],
  },
  {
    type: "hook.decision",
    variants: [
      {
        runId: "run_1",
        hookId: "lefthook:pre-commit",
        event: "PreToolUse",
        decision: "deny",
        toolName: "Bash",
        reason: "destructive command blocked by policy",
      },
      { runId: "run_1", hookId: "stop-hook:continue", event: "Stop", decision: "continuation" },
      { runId: "run_1", hookId: "hook_1", event: "PreToolUse", decision: "context" },
    ],
  },
  {
    type: "host.online",
    variants: [
      {
        branch: "main",
        git: {
          branch: "main",
          detached: null,
          dirty: true,
          ahead: 2,
          behind: 0,
          upstream: true,
          worktree: false,
        },
        providers: ["anthropic", "openai"],
        default: "anthropic",
        models: {
          anthropic: {
            label: "Claude",
            model: "claude-sonnet-5",
            reasoningLevels: ["low", "medium", "high"],
            defaultReasoning: "medium",
            kind: "cloud",
          },
        },
        instanceId: "inst_1",
        cwd: "/Users/kevin/dev/belay",
        workspace: "/Users/kevin/dev/belay",
        commands: [
          { name: "shell", summary: "Run a shell command", usage: "/shell <command>" },
          {
            name: "style",
            summary: "Choose output style",
            argumentHint: "<style>",
            body: "Set the output style to $ARGUMENTS",
          },
        ],
        agents: [
          {
            id: "code-reviewer",
            description: "Reviews diffs for bugs",
            tools: ["Read", "Grep"],
            skills: ["code-review"],
          },
        ],
        worktrees: [
          {
            id: "wt_1",
            baseRepo: "belay",
            baseRepoName: "belay",
            branch: "feature/auth",
            path: "/Users/kevin/dev/belay/.worktrees/feature-auth",
            sessionId: "sess_wt_1",
            dirty: true,
            ahead: 1,
            behind: 0,
            conflict: false,
            detached: false,
            current: true,
            baseline: false,
            missing: false,
          },
        ],
        internet: {
          status: "online",
          checking: false,
          checkedAt: "2026-07-10T12:00:00.000Z",
          error: null,
          targetClass: "dns+https",
        },
        sources: [
          {
            sourceId: "anthropic",
            type: "oauth",
            label: "Claude",
            status: "ready",
            modelCount: 4,
            auth: "authenticated",
            freshness: { refreshedAt: "2026-07-10T11:00:00.000Z", stale: false },
            actions: ["reauthenticate"],
          },
        ],
        catalog: {
          anthropic: [
            {
              sourceId: "anthropic",
              modelId: "claude-sonnet-5",
              displayName: "Claude Sonnet 5",
              kind: "cloud",
              capabilities: ["reasoning"],
              contextLength: 200000,
              costTier: "medium",
              aliases: ["sonnet"],
              freshness: { refreshedAt: "2026-07-10T11:00:00.000Z", stale: false },
              reasoningLevels: ["low", "medium", "high"],
              defaultReasoning: "medium",
            },
          ],
        },
        vimEnabled: true,
        jobs: [
          {
            id: "job_1",
            command: "npm run dev",
            source: "process",
            runId: "run_9",
            callId: "call_9",
            requestId: "req_9",
            cwd: "/Users/kevin/dev/belay",
            startedAt: 1750000000000,
            promotedAt: 1750000005000,
            status: "running",
            exitCode: null,
            stdoutTotal: 2048,
            stderrTotal: 0,
            tail: "Compiled successfully",
          },
        ],
        modelPrefs: {
          default: { sourceId: "anthropic", modelId: "claude-sonnet-5", reasoning: "medium" },
          pinned: [{ sourceId: "anthropic", modelId: "claude-opus-4.8", reasoning: null }],
        },
      },
      {
        providers: ["anthropic"],
        default: "anthropic",
        models: {},
        instanceId: "inst_2",
        cwd: "/tmp/scratch",
        workspace: "/tmp/scratch",
        commands: [],
        agents: [],
      },
    ],
  },
  {
    type: "provider.question.requested",
    variants: [
      {
        questionId: "q_1",
        runId: "run_1",
        toolCallId: "call_5",
        toolName: "ask_user",
        adapter: "ask_user",
        contract: {
          schemaVersion: 1,
          questions: [
            {
              id: "q1",
              question: "Which approach should I take?",
              answerShape: "single_choice",
              header: "Approach",
              kind: "decision",
              multiSelect: false,
              requiresReason: true,
              allowDefer: false,
              choices: [
                {
                  id: "c1",
                  label: "Rewrite the module",
                  description: "Clean slate",
                  preview: {
                    text: "New module skeleton",
                    viewport: "narrow",
                    before: "old code",
                    after: "new code",
                  },
                  recommended: true,
                  impact: "high",
                  risk: "medium",
                  badges: ["recommended"],
                  content: { planId: "plan_9" },
                },
                { id: "c2", label: "Patch in place" },
              ],
            },
          ],
        },
      },
      {
        questionId: "q_2",
        runId: "run_1",
        toolCallId: "call_6",
        toolName: "ask_user",
        adapter: "ask_user",
        contract: { schemaVersion: 1, questions: [] },
      },
    ],
  },
  {
    type: "provider.question.answer",
    variants: [
      {
        questionId: "q_1",
        answer: {
          action: "accept",
          answer: "Rewrite the module - option 1, reason: cleaner long term.",
          questions: [
            {
              id: "q1",
              answer: "Rewrite the module",
              selected: [{ id: "c1", label: "Rewrite the module" }],
              reason: "cleaner long term",
              content: { planId: "plan_9" },
            },
          ],
        },
      },
      { questionId: "q_2", answer: { action: "decline" } },
      { questionId: "q_3", answer: { action: "cancel" } },
    ],
  },
  {
    type: "provider.question.resolved",
    variants: [
      {
        questionId: "q_1",
        runId: "run_1",
        toolCallId: "call_5",
        outcome: "answered",
        summary: "User chose to rewrite the module.",
      },
      {
        questionId: "q_2",
        runId: "run_1",
        toolCallId: "call_6",
        outcome: "expired",
        summary: "Question expired with no answer.",
      },
      {
        questionId: "q_3",
        runId: "run_1",
        toolCallId: "call_7",
        outcome: "cancelled",
        summary: "",
      },
    ],
  },
  {
    type: "handoff.requested",
    variants: [
      {
        handoffId: "handoff_1",
        mode: "direct",
        sourceSessionId: "sess_source_1",
        prompt: "Continue the refactor in a fresh session.",
        proposed: true,
      },
      { handoffId: "handoff_1", mode: "generate", sourceSessionId: "sess_source_1" },
    ],
  },
  {
    type: "handoff.generating",
    variants: [
      { handoffId: "handoff_1", detail: "Summarizing the last 40 turns" },
      { handoffId: "handoff_1" },
    ],
  },
  {
    type: "handoff.generated",
    variants: [
      {
        handoffId: "handoff_1",
        prompt: "Continue refactoring src/auth.ts; tests pass, still need docs.",
        summary: "Refactor mostly done, docs remain",
      },
      { handoffId: "handoff_1", prompt: "" },
    ],
  },
  {
    type: "handoff.approved",
    variants: [
      { handoffId: "handoff_1", prompt: "Edited continuation prompt text." },
      { handoffId: "handoff_1" },
    ],
  },
  {
    type: "handoff.rejected",
    variants: [
      { handoffId: "handoff_1", reason: "Not ready to switch sessions yet." },
      { handoffId: "handoff_1" },
    ],
  },
  {
    type: "handoff.failed",
    variants: [
      { handoffId: "handoff_1", code: "generation_error", detail: "model returned empty prompt" },
      { handoffId: "handoff_1", code: "unknown" },
    ],
  },
  {
    type: "handoff.accepted",
    variants: [
      {
        handoffId: "handoff_1",
        targetSessionId: "sess_target_1",
        prompt: "Continue refactoring src/auth.ts.",
      },
      { handoffId: "handoff_1", targetSessionId: "sess_target_1", prompt: "" },
    ],
  },
  {
    type: "host.internet",
    variants: [
      {
        internet: {
          status: "offline",
          checking: false,
          checkedAt: "2026-07-10T11:59:00.000Z",
          error: "DNS resolution failed",
          targetClass: "dns+https",
        },
      },
      {
        internet: {
          status: "unknown",
          checking: true,
          checkedAt: null,
          error: null,
          targetClass: "none",
        },
      },
    ],
  },
  {
    type: "host.sourceAuth",
    variants: [
      {
        sourceId: "anthropic",
        phase: "device-code",
        verificationUri: "https://claude.ai/activate",
        userCode: "ABCD-1234",
        acceptsCode: true,
        detail: "Waiting for confirmation",
      },
      { sourceId: "openai", phase: "error", detail: "authentication failed" },
      { sourceId: "anthropic", phase: "complete" },
    ],
  },
  {
    type: "loop.status",
    variants: [
      {
        snapshot: {
          loopId: "loop_1",
          status: "failed",
          runner: "background_agent",
          durability: "durable",
          summary: 'max 10 · do "run the test suite"',
          completed: 3,
          max: 10,
          stopReason: "error",
          error: "agent crashed on iteration 4",
        },
      },
      {
        snapshot: {
          loopId: "loop_2",
          status: "running",
          runner: "current_session_prompt",
          durability: "session",
          summary: "until satisfied · watch CI",
          completed: 1,
          nextRun: 1750000060000,
        },
      },
      {
        snapshot: {
          loopId: "loop_3",
          status: "draft",
          runner: "process",
          durability: "session",
          summary: "",
          completed: 0,
        },
      },
    ],
  },
  {
    type: "host.hello",
    variants: [{ instanceId: "inst_1" }, {}],
  },
  {
    type: "host.beat",
    variants: [{ instanceId: "inst_1" }, {}],
  },
  {
    type: "host.role",
    variants: [{ instanceId: "inst_1", role: "leader" }, { instanceId: "inst_1" }],
  },
  {
    type: "admission.status",
    variants: [
      {
        runId: "run_1",
        phase: "queued",
        provider: "lmstudio",
        model: "qwen3-32b",
        priority: "background",
        position: 2,
      },
      {
        runId: "run_1",
        phase: "refused",
        provider: "lmstudio",
        model: "qwen3-32b",
        priority: "foreground",
        refusal: "runtime unavailable",
      },
      {
        runId: "run_1",
        phase: "acquired",
        provider: "lmstudio",
        model: "qwen3-32b",
        priority: "foreground",
      },
    ],
  },
];
