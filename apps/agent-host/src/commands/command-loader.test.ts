import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { type CommandFileRoot, loadCommandFilesFrom } from "./command-loader";

/**
 * The `.belay/commands/*.md` loader (plan 44.5 M3): ordered project->user roots, project-over-user
 * precedence (D-006), subdir recursion + `.md` filter + basename id, and fail-soft skips with a
 * structured diagnostic. Driven with temp-dir fixtures (the skills.test.ts pattern) - no global state.
 */

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fresh temp base holding a project root and a user root. */
function roots(): { project: CommandFileRoot; user: CommandFileRoot; base: string } {
  const base = mkdtempSync(join(tmpdir(), "belay-commands-"));
  temps.push(base);
  return {
    base,
    project: { kind: "project", dir: join(base, "project", ".belay", "commands") },
    user: { kind: "user", dir: join(base, "user", "commands") },
  };
}

/** Writes `<root>/<relative>.md` with the given body (relative may contain subdirs). */
function writeCommand(root: CommandFileRoot, relative: string, body: string): string {
  const path = join(root.dir, `${relative}.md`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

test("loads project `.belay/commands/*.md` as CommandFiles (id, rootKind, stripped body)", () => {
  const r = roots();
  writeCommand(
    r.project,
    "fix",
    "---\ndescription: fix an issue\nargument-hint: <issue>\n---\nFix issue #$0\n",
  );
  const { files } = loadCommandFilesFrom([r.project, r.user]);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.id, "/fix");
  assert.equal(files[0]?.rootKind, "project");
  assert.equal(files[0]?.body, "Fix issue #$0");
  assert.equal(files[0]?.summary, "fix an issue");
  assert.equal(files[0]?.argumentHint, "<issue>");
});

test("recurses subdirectories, ignores non-.md, and derives the id from the basename", () => {
  const r = roots();
  writeCommand(r.project, join("nested", "deploy"), "Deploy $ARGUMENTS");
  writeFileSync(join(r.project.dir, "notes.txt"), "ignore me");
  const { files } = loadCommandFilesFrom([r.project, r.user]);
  assert.deepEqual(
    files.map((f) => f.id),
    ["/deploy"],
  );
});

test("a user root loads too, and a project file overrides a same-named user file (D-006)", () => {
  const r = roots();
  writeCommand(r.project, "fix", "PROJECT fix $0");
  writeCommand(r.user, "fix", "USER fix $0");
  writeCommand(r.user, "review", "USER review $0");
  const { files } = loadCommandFilesFrom([r.project, r.user]);
  const byId = new Map(files.map((f) => [f.id, f]));
  assert.equal(byId.get("/fix")?.body, "PROJECT fix $0");
  assert.equal(byId.get("/fix")?.rootKind, "project");
  assert.equal(byId.get("/review")?.body, "USER review $0");
  assert.equal(byId.get("/review")?.rootKind, "user");
});

test("an empty-bodied file is skipped with a structured diagnostic, and siblings still load", () => {
  const r = roots();
  writeCommand(r.project, "blank", "---\ndescription: only frontmatter\n---\n");
  writeCommand(r.project, "good", "Do the thing $0");
  const { files, diagnostics } = loadCommandFilesFrom([r.project, r.user]);
  assert.deepEqual(
    files.map((f) => f.id),
    ["/good"],
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "empty");
  assert.match(diagnostics[0]?.path ?? "", /blank\.md$/);
});

test("blank frontmatter fields fall through: empty description -> generic summary, empty hint -> no usage", () => {
  const r = roots();
  writeCommand(r.project, "hollow", "---\ndescription: '   '\nargument-hint: ''\n---\nDo it $0\n");
  const { files } = loadCommandFilesFrom([r.project, r.user]);
  // A blank `description`/`argument-hint` must not surface as an empty summary or a trailing-space usage;
  // it falls through to the generic default / absent hint.
  assert.equal(files[0]?.summary, "Custom command /hollow");
  assert.equal(files[0]?.argumentHint, undefined);
});

test("a root path that is a file, not a directory, is skipped fail-soft, never a crash", () => {
  const r = roots();
  const filePath = join(r.base, "not-a-directory");
  writeFileSync(filePath, "i am a file, not a commands dir");
  const badRoot: CommandFileRoot = { kind: "project", dir: filePath };
  writeCommand(r.user, "ok", "user cmd $0");
  // readdirSync on a non-directory throws ENOTDIR; the walker must swallow it so one bad root can't
  // crash command registration at host boot (the user root still loads).
  const { files, diagnostics } = loadCommandFilesFrom([badRoot, r.user]);
  assert.deepEqual(
    files.map((f) => f.id),
    ["/ok"],
  );
  assert.equal(diagnostics.length, 0);
});

test("an unreadable file is skipped with a diagnostic, never a crash", (ctx) => {
  if (process.getuid?.() === 0) {
    ctx.skip(); // root bypasses chmod, so the unreadable path can't be simulated
    return;
  }
  const r = roots();
  const path = writeCommand(r.project, "locked", "secret $0");
  writeCommand(r.project, "open", "public $0");
  chmodSync(path, 0o000);
  try {
    const { files, diagnostics } = loadCommandFilesFrom([r.project, r.user]);
    assert.deepEqual(
      files.map((f) => f.id),
      ["/open"],
    );
    assert.equal(
      diagnostics.some((d) => d.code === "unreadable"),
      true,
    );
  } finally {
    chmodSync(path, 0o644);
  }
});
