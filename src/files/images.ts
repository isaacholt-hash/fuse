// Image attachments: accepted types, local resizing and token estimates (docs/providers.md, M1).
import type { ProviderId } from "@/catalog/catalog";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export const isImageType = (mime: string): mime is ImageType =>
  (IMAGE_TYPES as readonly string[]).includes(mime);

/** Long-edge cap applied before storing: fits both providers, and every turn resends images. */
export const MAX_IMAGE_EDGE = 2000;
/** Images already within the cap and under this size are kept byte for byte. */
const KEEP_ORIGINAL_BYTES = 4 * 1024 * 1024;

export function fitWithin(width: number, height: number, max = MAX_IMAGE_EDGE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * Estimated input tokens for one image. The bill comes from the provider's usage report; this is
 * for the composer's preview.
 * - Anthropic: ⌈w/28⌉ × ⌈h/28⌉, after scaling the long edge to ≤2,576 px (5.x models, ≤4,784).
 * - OpenAI (detail "high"): 32 px patches, capped at 2,500, × 1.2 (documented for gpt-6-astra;
 *   assumed for gpt-6.1-sol and gpt-6-luna, which the docs don't list).
 */
export function imageTokens(provider: ProviderId, width: number, height: number): number {
  if (provider === "anthropic") {
    const { width: w, height: h } = fitWithin(width, height, 2576);
    return Math.min(4784, Math.ceil(w / 28) * Math.ceil(h / 28));
  }
  let patches = Math.ceil(width / 32) * Math.ceil(height / 32);
  if (patches > 2500) {
    const s = Math.sqrt(2500 / patches);
    patches = Math.min(2500, Math.ceil((width * s) / 32) * Math.ceil((height * s) / 32));
  }
  return Math.ceil(patches * 1.2);
}

export interface PreparedImage {
  bytes: Uint8Array;
  mime: ImageType;
  width: number;
  height: number;
}

/**
 * Decodes an image in the webview and shrinks it to MAX_IMAGE_EDGE. GIFs become a still PNG
 * (both providers only read the first frame); large photos are re-encoded as JPEG.
 */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  if (!isImageType(file.type))
    throw new Error("Only PNG, JPEG, WebP and GIF images are supported.");
  const bitmap = await createImageBitmap(file);
  try {
    const target = fitWithin(bitmap.width, bitmap.height);
    const unchanged =
      target.width === bitmap.width &&
      file.type !== "image/gif" &&
      file.size <= KEEP_ORIGINAL_BYTES;
    if (unchanged) {
      return {
        bytes: new Uint8Array(await file.arrayBuffer()),
        mime: file.type,
        width: bitmap.width,
        height: bitmap.height,
      };
    }
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn't process the image.");
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    const mime: ImageType = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, mime, 0.9);
    });
    if (!blob) throw new Error("Couldn't process the image.");
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime, ...target };
  } finally {
    bitmap.close();
  }
}
