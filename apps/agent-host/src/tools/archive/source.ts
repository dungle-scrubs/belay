/**
 * Responsible for: acquiring archive bytes from a local path or an SSRF-guarded http(s) URL,
 * enforcing byte caps, redirect guarding, and download timeouts.
 * Not for: parsing the zip itself - zip.ts.
 */
import { lookup } from "node:dns/promises";
import { readFile, stat } from "node:fs/promises";
import {
  assertSafeRedirect,
  assertSafeUrl,
  type ResolveHost,
  UnsafeUrlError,
} from "../web-fetch/url-guard";
import { ArchiveToolError } from "./errors";

export type ArchiveFetch = typeof globalThis.fetch;
export type ArchiveResolveHost = (host: string) => Promise<readonly string[]>;

export interface ArchiveSourceDeps {
  readonly fetch: ArchiveFetch;
  readonly resolveHost: ArchiveResolveHost;
}

export interface ArchiveSourceOptions {
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly timeoutMs: number;
}

export type ArchiveSource =
  | { readonly kind: "path"; readonly label: string; readonly bytes: Uint8Array }
  | { readonly kind: "url"; readonly label: string; readonly bytes: Uint8Array };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const liveArchiveSourceDeps: ArchiveSourceDeps = {
  fetch: globalThis.fetch.bind(globalThis),
  resolveHost: async (host) => (await lookup(host, { all: true })).map((record) => record.address),
};

export async function readArchiveSource(
  input: { readonly path?: string; readonly url?: string },
  options: ArchiveSourceOptions,
  deps: ArchiveSourceDeps = liveArchiveSourceDeps,
): Promise<ArchiveSource> {
  if (input.path) {
    return {
      kind: "path",
      label: input.path,
      bytes: await readLocalArchive(input.path, options.maxBytes),
    };
  }
  if (input.url) {
    const url = await guardUrl(input.url, undefined, deps.resolveHost);
    return {
      kind: "url",
      label: url.toString(),
      bytes: await downloadArchive(url, options, deps),
    };
  }
  throw new ArchiveToolError({
    code: "ARCHIVE_URL_REJECTED",
    detail: "archive_read requires either path or url.",
  });
}

async function readLocalArchive(path: string, maxBytes: number): Promise<Uint8Array> {
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new ArchiveToolError({
      code: "ARCHIVE_URL_REJECTED",
      detail: "Archive path does not reference a readable file.",
    });
  }
  if (metadata.size > maxBytes) {
    throw new ArchiveToolError({
      code: "ARCHIVE_DOWNLOAD_TOO_LARGE",
      detail: "Archive file exceeds the configured byte limit.",
    });
  }
  const bytes = new Uint8Array(await readFile(path));
  if (bytes.byteLength > maxBytes) {
    throw new ArchiveToolError({
      code: "ARCHIVE_DOWNLOAD_TOO_LARGE",
      detail: "Archive file exceeds the configured byte limit.",
    });
  }
  return bytes;
}

async function downloadArchive(
  initialUrl: URL,
  options: ArchiveSourceOptions,
  deps: ArchiveSourceDeps,
): Promise<Uint8Array> {
  let current = initialUrl;
  const seen = new Set<string>([current.toString()]);

  for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
    const response = await requestOnce(current, options, deps);
    if (!REDIRECT_STATUSES.has(response.status)) {
      if (!response.ok) {
        throw new ArchiveToolError({
          code: "ARCHIVE_URL_REJECTED",
          detail: `Archive download failed with HTTP ${response.status}.`,
        });
      }
      return readResponseBytes(response, options.maxBytes);
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new ArchiveToolError({
        code: "ARCHIVE_URL_REJECTED",
        detail: "Archive download redirect did not include a location.",
      });
    }
    current = await guardRedirect(current, location, seen, deps.resolveHost);
    seen.add(current.toString());
  }

  throw new ArchiveToolError({
    code: "ARCHIVE_URL_REJECTED",
    detail: "Archive download exceeded the redirect limit.",
  });
}

async function requestOnce(
  url: URL,
  options: ArchiveSourceOptions,
  deps: ArchiveSourceDeps,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await deps.fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/zip,application/octet-stream,*/*;q=0.8" },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ArchiveToolError({
        code: "ARCHIVE_URL_REJECTED",
        detail: `Archive download timed out after ${options.timeoutMs}ms.`,
        cause: error,
      });
    }
    throw new ArchiveToolError({
      code: "ARCHIVE_URL_REJECTED",
      detail: error instanceof Error ? error.message : "Archive download failed.",
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
    throw new ArchiveToolError({
      code: "ARCHIVE_DOWNLOAD_TOO_LARGE",
      detail: "Archive download exceeds the configured byte limit.",
    });
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertDownloadLimit(bytes.byteLength, maxBytes);
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    totalBytes += chunk.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new ArchiveToolError({
        code: "ARCHIVE_DOWNLOAD_TOO_LARGE",
        detail: "Archive download exceeds the configured byte limit.",
      });
    }
    chunks.push(chunk.value);
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function assertDownloadLimit(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new ArchiveToolError({
      code: "ARCHIVE_DOWNLOAD_TOO_LARGE",
      detail: "Archive download exceeds the configured byte limit.",
    });
  }
}

async function guardUrl(
  raw: string,
  base: URL | undefined,
  resolveHost: ArchiveResolveHost,
): Promise<URL> {
  const sync = await syncResolverFor(raw, base, resolveHost);
  try {
    return assertSafeUrl(base ? new URL(raw, base).toString() : raw, sync);
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      throw new ArchiveToolError({ code: "ARCHIVE_URL_REJECTED", detail: error.reason });
    }
    throw error;
  }
}

async function guardRedirect(
  from: URL,
  to: string,
  seen: ReadonlySet<string>,
  resolveHost: ArchiveResolveHost,
): Promise<URL> {
  const sync = await syncResolverFor(to, from, resolveHost);
  try {
    return assertSafeRedirect({ from, to }, seen, sync);
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      throw new ArchiveToolError({ code: "ARCHIVE_URL_REJECTED", detail: error.reason });
    }
    throw error;
  }
}

async function syncResolverFor(
  raw: string,
  base: URL | undefined,
  resolveHost: ArchiveResolveHost,
): Promise<ResolveHost> {
  let host: string;
  try {
    host = new URL(raw, base).hostname;
  } catch {
    return () => [];
  }

  let literals: readonly string[];
  try {
    literals = await resolveHost(host);
  } catch {
    literals = [];
  }

  return (queried) => (queried === host ? literals : []);
}
