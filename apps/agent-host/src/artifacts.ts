import { exec } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type ArtifactRef, fetchBlobBytes } from "@trevor/session";
import type { ChatImage, ChatMessage } from "./providers";

const execAsync = promisify(exec);

/**
 * Host-side artifact resolution (D-028): a user.message carries content-addressed
 * ArtifactRefs, not bytes. At turn time, for a vision-capable provider, we fetch the
 * image bytes from the blob store beside Richter and inline them as base64 onto the
 * message (`images`) so the model can actually see them. Non-image artifacts are left
 * as refs - the provider surfaces them as a short text note.
 */

const BLOB_STORE_URL = process.env.BLOB_STORE_URL ?? "http://127.0.0.1:17423";

/** Image formats vision models reliably accept; anything else (e.g. HEIC) is not inlined. */
const MODEL_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const isModelImage = (a: ArtifactRef): boolean =>
  a.kind === "image" && MODEL_IMAGE_MIMES.has(a.mimeType.toLowerCase());

// Blobs are immutable (content-addressed), so cache the base64 by hash: a long turn
// history that re-sends the same image on every step never refetches or re-encodes it.
// Bounded (FIFO) so a long-lived host doesn't accumulate every image it has ever seen.
const CACHE_MAX = 32;
const cache = new Map<string, ChatImage>();
/** Hashes whose bytes don't decode as an image - skipped so they can't blank a vision turn. */
const undecodable = new Set<string>();

/**
 * Verifies bytes actually decode as an image (via `sips`). A corrupt image is the worst
 * case for a vision model: LM Studio doesn't error on it, it just returns an EMPTY response -
 * so one bad upload silently kills the turn. We skip such images instead.
 */
async function decodes(bytes: Uint8Array): Promise<boolean> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "img-check-"));
    const file = join(dir, "img");
    await writeFile(file, bytes);
    const { stdout } = await execAsync(`sips -g pixelWidth ${JSON.stringify(file)}`, {
      timeout: 15_000,
    });
    return /pixelWidth:\s*\d+/.test(stdout);
  } catch {
    return false;
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function resolveImage(ref: ArtifactRef): Promise<ChatImage | null> {
  if (undecodable.has(ref.hash)) {
    return null;
  }
  const hit = cache.get(ref.hash);
  if (hit) {
    return hit;
  }
  try {
    const bytes = await fetchBlobBytes(BLOB_STORE_URL, ref.hash);
    if (!(await decodes(bytes))) {
      undecodable.add(ref.hash);
      return null;
    }
    const image: ChatImage = {
      hash: ref.hash,
      mimeType: ref.mimeType,
      data: Buffer.from(bytes).toString("base64"),
    };
    cache.set(ref.hash, image);
    if (cache.size > CACHE_MAX) {
      cache.delete(cache.keys().next().value as string);
    }
    return image;
  } catch {
    // Store unreachable or blob gone: skip the image rather than fail the turn - the model
    // still gets the text and the non-image artifact note.
    return null;
  }
}

/**
 * Inlines the image artifacts of each user message as base64 (`message.images`). Returns
 * the history unchanged when nothing references an image, so the common no-attachment turn
 * pays nothing. Call only for providers that accept images.
 */
export async function resolveHistoryImages(
  history: readonly ChatMessage[],
): Promise<readonly ChatMessage[]> {
  const hasImages = history.some((m) => m.role === "user" && m.artifacts?.some(isModelImage));
  if (!hasImages) {
    return history;
  }
  return Promise.all(
    history.map(async (message) => {
      const imageRefs = message.artifacts?.filter(isModelImage) ?? [];
      if (message.role !== "user" || imageRefs.length === 0) {
        return message;
      }
      const resolved = await Promise.all(imageRefs.map(resolveImage));
      const images = resolved.filter((img): img is ChatImage => img !== null);
      return images.length ? { ...message, images } : message;
    }),
  );
}
