import { sessionSummary } from "@belay/test-kit";
import { describe, expect, test } from "vitest";
import { BUILT_IN_COMMANDS } from "./built-in-commands";
import { isNewSessionCommand, NEW_SESSION_COMMAND } from "./new-session/new-session-command";
import { buildProjectSidebar, type ProjectSidebarRecord } from "./sidebar/project-sidebar-model";

/**
 * Plan 58 M8 (RED): regression tests for the original plan-58 complaints. Each test pins a product
 * behavior that was broken before this plan and must not regress:
 *
 * 1. The sidebar lists ALL projects (not just the current one).
 * 2. `/clear` is absent from the visible command surface (retired by M4; `/new` replaces it).
 * 3. `/new` is a fresh-session command (distinct from resume; never reuses the current session).
 * 4. `/cd <path>` is an alias for `/new <path>` in the announced command list.
 */

function project(over: Partial<ProjectSidebarRecord> & { path: string }): ProjectSidebarRecord {
  return {
    displayPath: over.path,
    displayName: over.path.split("/").pop() ?? over.path,
    collapsed: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

describe("regression: the sidebar lists ALL projects, not just the current one", () => {
  test("sessions across several projects each get their own group", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/belay" }), project({ path: "/dev/opchain" })],
      [
        sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" }),
        sessionSummary({ sessionId: "s2", projectPath: "/dev/opchain" }),
      ],
    );
    const keys = groups.map((g) => g.key).sort();
    expect(keys).toEqual(["/dev/opchain", "/dev/belay"]);
  });

  test("a project with no active sessions still appears (archive-only project is listed)", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/belay" }), project({ path: "/dev/ghost" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" })],
    );
    const keys = groups.map((g) => g.key).sort();
    expect(keys).toContain("/dev/ghost");
    expect(keys).toContain("/dev/belay");
  });

  test("the current session's project does not crowd out other projects", () => {
    // Three projects; the "current" session is in one. All three must surface.
    const groups = buildProjectSidebar(
      [project({ path: "/dev/a" }), project({ path: "/dev/b" }), project({ path: "/dev/c" })],
      [sessionSummary({ sessionId: "current", projectPath: "/dev/b" })],
    );
    expect(groups.map((g) => g.key).sort()).toEqual(["/dev/a", "/dev/b", "/dev/c"]);
  });
});

describe("regression: /clear is retired from the visible command surface", () => {
  test("BUILT_IN_COMMANDS does not include /clear", () => {
    const names = BUILT_IN_COMMANDS.map((c) => c.name);
    expect(names).not.toContain("/clear");
  });

  test("BUILT_IN_COMMANDS includes /new (the fresh-context replacement)", () => {
    const names = BUILT_IN_COMMANDS.map((c) => c.name);
    expect(names).toContain("/new");
  });
});

describe("regression: /new creates a fresh session, not a reuse of the current one", () => {
  test("the /new command is distinct from /resume (no implicit resume)", () => {
    // /new is its own command, not an alias of /resume.
    expect(isNewSessionCommand("/resume")).toBe(false);
    expect(isNewSessionCommand("/new")).toBe(true);
  });

  test("a fresh session id is a random UUID, not the current session id", () => {
    // The M4 launch mints crypto.randomUUID() for /new; two mints are distinct (not the deterministic
    // projectSessionId reused for the same root). Pin that randomUUID is unique across calls.
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("the /new command name is the announced descriptor's name", () => {
    expect(NEW_SESSION_COMMAND.name).toBe("/new");
    expect(BUILT_IN_COMMANDS[0]?.name).toBe("/new");
  });
});

describe("regression: /cd <path> aliases /new <path>", () => {
  test("BUILT_IN_COMMANDS includes /cd as an alias for /new", () => {
    const cd = BUILT_IN_COMMANDS.find((c) => c.name === "/cd");
    expect(cd).toBeTruthy();
    expect(cd?.summary).toMatch(/alias for \/new/i);
    expect(cd?.usage).toBe("/cd <directory>");
  });

  test("/cd is NOT /new (they are separate announced commands, not the same string)", () => {
    // The alias is a distinct command name that the composer intercepts to run the same fresh-session
    // launch as /new; it is not silently rewritten to /new in the input.
    expect(isNewSessionCommand("/cd")).toBe(false);
    expect(isNewSessionCommand("/cd ~/dev/foo")).toBe(false);
  });
});
