export const MAX_IMAGES_PER_MESSAGE = 4;
export const TARGET_IMAGE_BYTES = 1_000_000;

const RAW_UNSAFE = /[ "'`$;&|<>(){}[\]*?!#\\]/;
const IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|gif|webp|heic|heif|avif|bmp|svg)$/i;

/** True when `file` has an `image/*` MIME type or a recognized image filename extension (e.g. `.heic` with empty `file.type`). */
export function isSupportedImageFile(file: Pick<File, "type" | "name">): boolean {
  if (typeof file.type === "string" && file.type.toLowerCase().startsWith("image/")) {
    return true;
  }
  return IMAGE_EXTENSION_RE.test(file.name || "");
}

/** Text to paste for an uploaded image path, or null when the path has control bytes. */
export function formatImagePastePath(path: string): string | null {
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  if (!RAW_UNSAFE.test(path)) return path;
  return path.replace(/[^a-zA-Z0-9_./@:\-\u0080-\uffff]/g, "\\$&");
}

export class PartialSendError extends Error {
  delivered: number;
  constructor(message: string, delivered: number) {
    super(message);
    this.name = "PartialSendError";
    this.delivered = delivered;
  }
}

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
  dataUrl: string;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    };
    reader.readAsDataURL(blob);
  });
}

/** Downsizes `file` to JPEG under `TARGET_IMAGE_BYTES`. Browser only (canvas). */
export async function prepareImageForUpload(file: File): Promise<PreparedImage> {
  if (!isSupportedImageFile(file)) {
    throw new Error("Only images can be attached.");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (/\.hei[cf]$/i.test(file.name || "") || /hei[cf]/i.test(file.type || "")) {
      throw new Error("This browser cannot decode HEIC photos directly; try JPEG or PNG.");
    }
    throw new Error("Could not decode the selected image.");
  }
  try {
    for (const [max, quality] of COMPRESSION_STEPS) {
      const { width, height } = fitDimensions(bitmap.width, bitmap.height, max);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Image processing is not available in this browser.");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
      if (blob && blob.size <= TARGET_IMAGE_BYTES) {
        const dataUrl = await blobToDataUrl(blob);
        const commaIdx = dataUrl.indexOf(",");
        return {
          base64: commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl,
          previewUrl: URL.createObjectURL(blob),
          dataUrl,
        };
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error("The image is too large to send.");
}
