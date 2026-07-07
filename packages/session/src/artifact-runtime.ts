import {
  artifactRef,
  type BlobMetaProbe,
  blobUrl,
  fetchBlobBytes,
  HEX64,
  headBlob,
  putBlob,
} from "./blob";
import type { PutBlobResult } from "./blob-contract";
import type { ArtifactRef } from "./protocol";

/**
 * Shared artifact runtime policy over the content-addressed blob store.
 *
 * Responsible for: artifact kind classification, blob URL resolution, upload/download/head helpers,
 * model-image eligibility, optional image-byte validation, and frame artifact creation.
 * Not for: browser UI rendering, host provider message shaping, or video transcoding.
 */

export type ArtifactSource = Blob | Uint8Array;

export interface ResolvedArtifactImage {
  readonly hash: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface ArtifactRuntime {
  classify(mimeType: string): ArtifactRef["kind"];
  artifactUrl(hash: string): string;
  upload(
    source: ArtifactSource,
    mimeType: string,
    options?: { readonly kind?: ArtifactRef["kind"]; readonly name?: string },
  ): Promise<ArtifactRef>;
  download(ref: string | ArtifactRef): Promise<Uint8Array>;
  head(hash: string): Promise<BlobMetaProbe | null>;
  createFrameArtifact(bytes: Uint8Array, mimeType?: string): Promise<ArtifactRef>;
  isModelImage(ref: ArtifactRef): boolean;
  tryResolveModelImage(ref: ArtifactRef): Promise<ResolvedArtifactImage | null>;
}

export interface ArtifactRuntimeOptions {
  readonly blobStoreUrl: string;
  readonly put?: (
    baseUrl: string,
    body: ArtifactSource,
    mimeType: string,
  ) => Promise<PutBlobResult>;
  readonly fetchBytes?: (baseUrl: string, hash: string) => Promise<Uint8Array>;
  readonly head?: (baseUrl: string, hash: string) => Promise<BlobMetaProbe | null>;
  readonly validateImage?: (bytes: Uint8Array, ref: ArtifactRef) => Promise<boolean> | boolean;
}

const MODEL_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function classifyArtifactKind(mimeType: string): ArtifactRef["kind"] {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized === "application/pdf" || normalized.startsWith("text/")) {
    return "document";
  }
  return "file";
}

export function isModelImageArtifact(ref: ArtifactRef): boolean {
  return ref.kind === "image" && MODEL_IMAGE_MIMES.has(ref.mimeType.toLowerCase());
}

function hashOf(ref: string | ArtifactRef): string {
  return typeof ref === "string" ? ref : ref.hash;
}

export function createArtifactRuntime(options: ArtifactRuntimeOptions): ArtifactRuntime {
  const put = options.put ?? putBlob;
  const fetchBytes = options.fetchBytes ?? fetchBlobBytes;
  const head = options.head ?? headBlob;

  const upload: ArtifactRuntime["upload"] = async (source, mimeType, uploadOptions) => {
    const result = await put(options.blobStoreUrl, source, mimeType);
    return artifactRef(
      result,
      uploadOptions?.kind ?? classifyArtifactKind(mimeType),
      uploadOptions?.name,
    );
  };

  return {
    classify: classifyArtifactKind,
    artifactUrl: (hash) => blobUrl(options.blobStoreUrl, hash),
    upload,
    download: async (ref) => {
      const hash = hashOf(ref);
      if (!HEX64.test(hash)) {
        throw new Error(`not a valid blob hash: ${hash}`);
      }
      return fetchBytes(options.blobStoreUrl, hash);
    },
    head: async (hash) => {
      if (!HEX64.test(hash)) {
        throw new Error(`not a valid blob hash: ${hash}`);
      }
      return head(options.blobStoreUrl, hash);
    },
    createFrameArtifact: (bytes, mimeType = "image/png") =>
      upload(bytes, mimeType, { kind: "image" }),
    isModelImage: isModelImageArtifact,
    tryResolveModelImage: async (ref) => {
      if (!isModelImageArtifact(ref)) {
        return null;
      }
      try {
        const bytes = await fetchBytes(options.blobStoreUrl, ref.hash);
        if (options.validateImage && !(await options.validateImage(bytes, ref))) {
          return null;
        }
        return { hash: ref.hash, mimeType: ref.mimeType, bytes };
      } catch {
        return null;
      }
    },
  };
}
