import { writeFileSync } from "node:fs";

/**
 * The scriptable hook FIXTURE the runner integration tests spawn (plan 25 M3): a tiny node
 * process whose first argv token selects a behavior - echo argv back as a decision (the
 * no-shell proof), echo stdin back (payload delivery), print a literal (JSON contract cases),
 * record stdin to a file then exit silently (payload capture + the implicit-allow shape, 25 M5),
 * hang (timeout ladder, optionally ignoring SIGTERM to force the SIGKILL rung), spew bytes
 * (output caps), fail with stderr + exit code, or report cwd/env (spawn hygiene).
 *
 * Responsible for: deterministic child-side behaviors for the hook runner tests.
 * Not for: the launch recipe - ./fixture-config owns that.
 */

const mode = process.argv[2] ?? "";

/** Prints an allow decision whose context carries `text` verbatim. */
function allowWithContext(text: string): void {
  process.stdout.write(`${JSON.stringify({ decision: "allow", context: text })}\n`);
}

switch (mode) {
  case "argv": {
    // The no-shell proof: every arg after the mode is echoed exactly as received.
    allowWithContext(JSON.stringify(process.argv.slice(3)));
    break;
  }
  case "stdin": {
    // Payload delivery: resolves only when stdin CLOSES, so it also proves the runner ends stdin.
    let payload = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      payload += chunk;
    });
    process.stdin.on("end", () => allowWithContext(payload));
    break;
  }
  case "print": {
    process.stdout.write(process.argv[3] ?? "");
    break;
  }
  case "record": {
    // Payload capture: write stdin verbatim to the file at argv[3], then exit 0 with NO stdout -
    // the observe-only hook shape that M5's implicit allow covers. The file's existence doubles
    // as the "did this hook execute at all?" probe for gate/short-circuit tests.
    let payload = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      payload += chunk;
    });
    process.stdin.on("end", () => writeFileSync(process.argv[3] ?? "", payload));
    break;
  }
  case "cwd": {
    allowWithContext(process.cwd());
    break;
  }
  case "env": {
    allowWithContext(JSON.stringify(Object.keys(process.env).sort()));
    break;
  }
  case "spew": {
    // Output caps: argv[3] chars of "o" to stdout, argv[4] chars of "e" to stderr.
    process.stdout.write("o".repeat(Number(process.argv[3] ?? 0)));
    process.stderr.write("e".repeat(Number(process.argv[4] ?? 0)));
    break;
  }
  case "fail": {
    process.stderr.write(process.argv[3] ?? "");
    process.exit(Number(process.argv[4] ?? 1));
    break;
  }
  case "hang": {
    if (process.argv[3] === "ignore-sigterm") {
      process.on("SIGTERM", () => {});
    }
    setInterval(() => {}, 1_000);
    break;
  }
  default: {
    process.stderr.write(`unknown fixture mode: ${mode}`);
    process.exit(64);
  }
}
