import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import jsQR from "jsqr";

/** Minimal typing for the Shape Detection API (not in lib.dom for every TS version). */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

function detectorCtor(): BarcodeDetectorCtor | null {
  const g = globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
  return g.BarcodeDetector ?? null;
}

type Decode = (video: HTMLVideoElement) => Promise<string | null>;

function makeDecoder(): Decode {
  const Ctor = detectorCtor();
  if (Ctor) {
    const detector = new Ctor({ formats: ["qr_code"] });
    return async (video) =>
      (await detector.detect(video)).find((c) => c.rawValue)?.rawValue ?? null;
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return async (video) => {
    if (!ctx || !video.videoWidth) return null;
    const scale = Math.min(1, 1080 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height)?.data || null;
  };
}

export function QrScanModal({
  onResult,
  onClose,
}: {
  onResult: (text: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const decode = makeDecoder();

    const tick = async () => {
      const video = videoRef.current;
      if (stopped || !video) return;
      try {
        if (video.readyState >= 2) {
          const text = await decode(video);
          if (text) {
            stopped = true;
            onResult(text);
            return;
          }
        }
      } catch {
        // transient detect failure: keep scanning
      }
      timer = setTimeout(tick, 250);
    };

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const video = videoRef.current;
        if (video) {
          video.srcObject = s;
          void video.play().catch(() => undefined);
        }
        void tick();
      })
      .catch(() => setError("Camera access was denied or is unavailable."));

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black">
      <div className="flex items-center justify-between px-4 pt-[calc(0.75rem+env(safe-area-inset-top,0px))] pb-3">
        <span className="text-[15px] font-semibold text-white">Scan pairing QR</span>
        <button
          type="button"
          onClick={onClose}
          className="w-9 h-9 rounded-xl bg-white/10 text-white flex items-center justify-center"
          aria-label="Close scanner"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="flex-1 flex items-center justify-center p-4">
        {error ? (
          <p className="text-[14px] text-amber-300 text-center max-w-xs">{error}</p>
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full max-h-full rounded-2xl object-cover"
          />
        )}
      </div>
    </div>
  );
}
