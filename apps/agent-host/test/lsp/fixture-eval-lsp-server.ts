import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The WORKSPACE-DERIVED stdio LSP fixture for the plan 24 M7 evals: unlike
 * ./fixture-lsp-server.ts (canned protocol answers for client/manager mechanics), this server
 * answers from the REAL fixture workspace it is initialized against, so the eval assertions
 * (a workspace-symbol result that carries the true definition location, an outline that covers
 * a file's actual top-level symbols, a hover that returns the declared signature, diagnostics
 * that pinpoint the offending file+line) measure genuine navigation value, not echoes. It
 * speaks JSON-RPC 2.0 over LSP Content-Length frames with its own tiny framing implementation,
 * per the fixture precedent, so the tests stay cross-implementation.
 *
 * Behaviors, all derived from workspace content:
 * - `workspace/symbol`: scans the workspace's .ts files for top-level declarations whose name
 *   contains the query (case-insensitive) and returns their real locations.
 * - `textDocument/documentSymbol`: the open document's top-level declarations, each spanning to
 *   the next declaration.
 * - `textDocument/hover`: the word at the position, answered with its declaration line as a
 *   fenced typescript signature; a uri containing "hang" is never answered (timeout tests).
 * - didOpen/didChange always publish (possibly empty) diagnostics: a `: number = "..."` line
 *   yields one TS2322-style error; every line containing "noisy_diag" yields one warning, which
 *   is how the noisy-server regression produces hundreds of diagnostics from one file.
 *
 * Exits 0 when stdin ends.
 */

interface JsonRpcIn {
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: {
    readonly rootUri?: string;
    readonly rootPath?: string;
    readonly textDocument?: { readonly uri?: string; readonly text?: string };
    readonly position?: { readonly line?: number; readonly character?: number };
    readonly contentChanges?: readonly { readonly text?: string }[];
    readonly query?: string;
  };
}

interface Declaration {
  readonly keyword: string;
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly character: number;
  readonly text: string;
}

/** The workspace root captured from initialize. */
let rootPath = process.cwd();

/** The open documents' current full text, keyed by uri (full-sync fixture). */
const documents = new Map<string, string>();

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainFrames();
});
process.stdin.on("end", () => process.exit(0));

function drainFrames(): void {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match?.[1]) {
      process.exit(2);
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) {
      return;
    }
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body) as JsonRpcIn);
  }
}

function send(message: unknown): void {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function result(id: JsonRpcIn["id"], value: unknown): void {
  send({ jsonrpc: "2.0", id, result: value });
}

// --- workspace scanning ---

const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist"]);

function workspaceTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        files.push(...workspaceTsFiles(join(dir, entry.name)));
      }
    } else if (entry.name.endsWith(".ts")) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

const DECL_PATTERN =
  /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(function|class|interface|enum|type|const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

/** Top-level declarations (column-0 keyword) in one file's text. */
function declarationsIn(file: string, text: string): Declaration[] {
  return text.split("\n").flatMap((line, index) => {
    const match = DECL_PATTERN.exec(line);
    if (!match?.[1] || !match[2]) {
      return [];
    }
    return [
      {
        keyword: match[1],
        name: match[2],
        file,
        line: index,
        character: line.indexOf(match[2]),
        text: line,
      },
    ];
  });
}

function workspaceDeclarations(): Declaration[] {
  return workspaceTsFiles(rootPath).flatMap((file) =>
    declarationsIn(file, readFileSync(file, "utf8")),
  );
}

const SYMBOL_KINDS: Readonly<Record<string, number>> = {
  function: 12,
  class: 5,
  interface: 11,
  enum: 10,
  type: 13,
  const: 14,
  let: 13,
};

function nameRange(decl: Declaration): unknown {
  return {
    start: { line: decl.line, character: decl.character },
    end: { line: decl.line, character: decl.character + decl.name.length },
  };
}

// --- diagnostics, derived from document content ---

/** One TS2322-style error per `: number = "…"` line, one warning per "noisy_diag" line. */
function diagnosticsFor(text: string): unknown[] {
  return text.split("\n").flatMap((line, index) => {
    const mismatch = /:\s*number\s*=\s*["']/.exec(line);
    if (mismatch) {
      const character = line.indexOf("=", mismatch.index) + 2;
      return [
        {
          range: {
            start: { line: index, character },
            end: { line: index, character: line.length },
          },
          severity: 1,
          source: "ts",
          code: 2322,
          message: "Type 'string' is not assignable to type 'number'.",
        },
      ];
    }
    if (line.includes("noisy_diag")) {
      return [
        {
          range: {
            start: { line: index, character: 0 },
            end: { line: index, character: line.length },
          },
          severity: 2,
          source: "ts",
          message: `noisy_diag warning on line ${index + 1}`,
        },
      ];
    }
    return [];
  });
}

function publishDiagnostics(uri: string, text: string): void {
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics: diagnosticsFor(text) },
  });
}

// --- hover ---

function wordAt(text: string, line: number, character: number): string | undefined {
  const content = text.split("\n")[line] ?? "";
  const isWord = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
  if (!isWord(content[character] ?? "")) {
    return undefined;
  }
  let start = character;
  while (start > 0 && isWord(content[start - 1] ?? "")) {
    start -= 1;
  }
  let end = character;
  while (end < content.length && isWord(content[end] ?? "")) {
    end += 1;
  }
  return content.slice(start, end);
}

/** The declaration line for a name, cut before its body, as the hover signature. */
function signatureFor(name: string): string | undefined {
  const decl = workspaceDeclarations().find((candidate) => candidate.name === name);
  if (!decl) {
    return undefined;
  }
  const bodyStart = decl.text.indexOf("{");
  return (bodyStart === -1 ? decl.text : decl.text.slice(0, bodyStart)).trim();
}

// --- dispatch ---

function handle(message: JsonRpcIn): void {
  const { method, id, params } = message;
  if (method === undefined) {
    return; // the client never sends us responses in this fixture
  }

  if (method === "initialize") {
    if (params?.rootUri) {
      rootPath = fileURLToPath(params.rootUri);
    } else if (params?.rootPath) {
      rootPath = params.rootPath;
    }
    result(id, {
      capabilities: {
        textDocumentSync: 1,
        hoverProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
      },
      serverInfo: { name: "trevor-lsp-eval-fixture", version: "0.0.1" },
    });
    return;
  }
  if (method === "shutdown") {
    result(id, null);
    return;
  }
  if (method === "exit") {
    process.exit(0);
  }

  if (method === "textDocument/didOpen") {
    const uri = params?.textDocument?.uri ?? "";
    const text = params?.textDocument?.text ?? "";
    documents.set(uri, text);
    publishDiagnostics(uri, text);
    return;
  }
  if (method === "textDocument/didChange") {
    const uri = params?.textDocument?.uri ?? "";
    const text = params?.contentChanges?.[0]?.text ?? "";
    documents.set(uri, text);
    publishDiagnostics(uri, text);
    return;
  }
  if (method === "textDocument/didClose") {
    documents.delete(params?.textDocument?.uri ?? "");
    return;
  }

  if (method === "workspace/symbol") {
    const query = (params?.query ?? "").toLowerCase();
    result(
      id,
      workspaceDeclarations()
        .filter((decl) => decl.name.toLowerCase().includes(query))
        .map((decl) => ({
          name: decl.name,
          kind: SYMBOL_KINDS[decl.keyword] ?? 13,
          location: { uri: pathToFileURL(decl.file).href, range: nameRange(decl) },
        })),
    );
    return;
  }

  if (method === "textDocument/documentSymbol") {
    const uri = params?.textDocument?.uri ?? "";
    const text = documents.get(uri) ?? "";
    const decls = declarationsIn(uri, text);
    const lastLine = text.split("\n").length - 1;
    result(
      id,
      decls.map((decl, index) => ({
        name: decl.name,
        kind: SYMBOL_KINDS[decl.keyword] ?? 13,
        range: {
          start: { line: decl.line, character: 0 },
          end: { line: (decls[index + 1]?.line ?? lastLine + 1) - 1, character: 0 },
        },
        selectionRange: nameRange(decl),
        children: [],
      })),
    );
    return;
  }

  if (method === "textDocument/hover") {
    const uri = params?.textDocument?.uri ?? "";
    if (uri.includes("hang")) {
      return; // deliberately never responds (request-timeout distraction tests)
    }
    const text = documents.get(uri) ?? "";
    const word = wordAt(text, params?.position?.line ?? 0, params?.position?.character ?? 0);
    const signature = word === undefined ? undefined : signatureFor(word);
    if (signature === undefined) {
      result(id, null);
      return;
    }
    result(id, { contents: { kind: "markdown", value: `\`\`\`typescript\n${signature}\n\`\`\`` } });
    return;
  }

  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `method not found: ${method}` },
    });
  }
}
