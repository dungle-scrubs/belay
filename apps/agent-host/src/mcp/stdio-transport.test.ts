import { describe, expect, test } from "vitest";
import { STDIO_CHILD_ENV_ALLOWLIST, stdioChildEnv } from "./stdio-transport";

describe("stdioChildEnv (D-004 secret-minimal child environment)", () => {
  const hostEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/somebody",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TMPDIR: "/tmp/x",
    OPENAI_API_KEY: "sk-nope",
    ANTHROPIC_API_KEY: "sk-ant-nope",
    DEEPSEEK_API_KEY: "dk-nope",
    ZAI_API_KEY: "zai-nope",
    MINIMAX_API_KEY: "mm-nope",
    OPENROUTER_API_KEY: "or-nope",
    TREVOR_WORKSPACE: "/somewhere",
    SESSION_ID: "sess-1",
    RANDOM_OTHER: "value",
  };

  test("passes through only the allowlisted vars", () => {
    expect(stdioChildEnv(hostEnv, {})).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/somebody",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TMPDIR: "/tmp/x",
    });
  });

  test("never includes provider keys, TREVOR_*, or SESSION_ID", () => {
    const env = stdioChildEnv(hostEnv, {});
    for (const name of Object.keys(env)) {
      expect(STDIO_CHILD_ENV_ALLOWLIST).toContain(name);
    }
  });

  test("omits allowlisted vars the host does not have", () => {
    expect(stdioChildEnv({ PATH: "/bin" }, {})).toEqual({ PATH: "/bin" });
  });

  test("layers explicit per-server env on top, winning over the allowlist", () => {
    expect(stdioChildEnv(hostEnv, { GITHUB_TOKEN: "gh-explicit", HOME: "/srv/mcp" })).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/srv/mcp",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TMPDIR: "/tmp/x",
      GITHUB_TOKEN: "gh-explicit",
    });
  });
});
