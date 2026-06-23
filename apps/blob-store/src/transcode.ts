import { exec } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * HEIC/HEIF normalization. iPhone photos arrive as HEIC, which browsers can't render in
 * an <img> and which vision models reject - so the store transcodes them to JPEG on upload
 * (via macOS `sips`, no npm deps), and everything downstream - thumbnail, dedup, the model -
 * sees a usable image. Best-effort: if `sips` is missing or the bytes aren't convertible the
 * caller stores the original untouched.
 */

const execAsync = promisify(exec);

const HEIC_MIMES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);
const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);

/** True for a HEIC/HEIF content-type. */
export function isHeicMime(mimeType: string): boolean {
  return HEIC_MIMES.has(mimeType.toLowerCase());
}

/** Sniffs the ISO-BMFF `ftyp` brand, so a HEIC that arrives as octet-stream is still caught. */
export function looksLikeHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 12) {
    return false;
  }
  const tag = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  return tag(4, 8) === "ftyp" && HEIC_BRANDS.has(tag(8, 12));
}

/** Transcodes HEIC/HEIF bytes to JPEG with `sips`, or null if the conversion isn't available. */
export async function heicToJpeg(bytes: Uint8Array): Promise<Uint8Array | null> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "blob-heic-"));
    const src = join(dir, "in.heic");
    const out = join(dir, "out.jpg");
    await writeFile(src, bytes);
    await execAsync(`sips -s format jpeg ${JSON.stringify(src)} --out ${JSON.stringify(out)}`, {
      timeout: 30_000,
    });
    return await readFile(out);
  } catch {
    return null;
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
