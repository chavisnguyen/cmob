/**
 * Image attachments for the composer.
 *
 * The phone downsizes a photo, uploads it (`mobile.upload.image`) and gets back a path on the Mac. On send
 * that path is pasted into the agent on its own, before the message: terminal TUIs treat a pasted image file
 * path as an attachment (Orca: ref/orca/src/shared/image-path-paste.ts:9, `formatImageDropPasteText`).
 * Not verified against a live Claude/Codex session in this repo; see .context/audit_report.md section K.
 */

export const MAX_IMAGES_PER_MESSAGE = 4;
/** Raw size target; the gateway accepts up to 1.4 MB and the WebSocket frame cap is 2 MiB (base64 +33%). */
export const TARGET_IMAGE_BYTES = 1_000_000;

// Port of Orca POSIX_RAW_IMAGE_DROP_UNSAFE_RE / backslashEscapePosixPath (image-path-paste.ts:10, 71-73):
// a path with spaces or shell metacharacters is backslash-escaped, which round-trips across Claude/Codex.
const RAW_UNSAFE = /[ "'`$;&|<>(){}[\]*?!#\\]/;

/** Text to paste for an uploaded image path, or null when the path has control bytes. */
export function formatImagePastePath(path: string): string | null {
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  if (!RAW_UNSAFE.test(path)) return path;
  return path.replace(/[^a-zA-Z0-9_./@:\-\u0080-￿]/g, "\\$&");
}

/** A send that pasted `delivered` image paths into the agent before failing; those must not be pasted again. */
export class PartialSendError extends Error {
  delivered: number;
  constructor(message: string, delivered: number) {
    super(message);
    this.name = "PartialSendError";
    this.delivered = delivered;
  }
}

/** Scales (w, h) down so the longer side is at most `max`, keeping the aspect ratio. Never upscales. */
export function fitDimensions(
  w: number,
  h: number,
  max: number,
): { width: number; height: number } {
  const longest = Math.max(w, h);
  if (longest <= max) return { width: w, height: h };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Attempt ladder: (max side, JPEG quality), from best quality to smallest. */
export const COMPRESSION_STEPS: ReadonlyArray<readonly [number, number]> = [
  [2048, 0.85],
  [1600, 0.8],
  [1280, 0.7],
  [1024, 0.6],
  [800, 0.5],
];

export interface PreparedImage {
  base64: string;
  previewUrl: string;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** Downsizes `file` to JPEG under `TARGET_IMAGE_BYTES`. Browser only (canvas). */
export async function prepareImageForUpload(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith("image/")) throw new Error("Only images can be attached.");
  const bitmap = await createImageBitmap(file);
  try {
    for (const [max, quality] of COMPRESSION_STEPS) {
      const { width, height } = fitDimensions(bitmap.width, bitmap.height, max);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Image processing is not available in this browser.");
      ctx.fillStyle = "#ffffff"; // JPEG has no alpha
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
      if (blob && blob.size <= TARGET_IMAGE_BYTES) {
        return { base64: await blobToBase64(blob), previewUrl: URL.createObjectURL(blob) };
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error("The image is too large to send.");
}
