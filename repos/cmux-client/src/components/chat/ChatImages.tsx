import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImageOff, Loader2, X } from "lucide-react";
import { cachedChatImage } from "./chatImageCache";
import { useFetchChatImage } from "./ChatImageContext";

/** Full-screen image viewer; tap the image to toggle between fit and actual size. */
export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [actual, setActual] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Portal: chat rows live under a transformed virtualizer, which would trap `position: fixed`.
  return createPortal(
    <div
      role="dialog"
      aria-label="Image preview"
      className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image"
        className="absolute right-3 top-[calc(0.75rem+env(safe-area-inset-top,0px))] z-10 w-9 h-9 rounded-full bg-black/60 text-white flex items-center justify-center"
      >
        <X className="w-5 h-5" />
      </button>
      <div
        className={`w-full h-full ${actual ? "overflow-auto" : "flex items-center justify-center overflow-hidden"}`}
      >
        <img
          src={src}
          alt="Attached"
          onClick={(e) => {
            e.stopPropagation();
            setActual((v) => !v);
          }}
          className={
            actual
              ? "max-w-none cursor-zoom-out"
              : "max-w-full max-h-full object-contain cursor-zoom-in"
          }
        />
      </div>
    </div>,
    document.body,
  );
}

type ThumbState = { status: "idle" | "loading" | "error" } | { status: "ready"; src: string };

/**
 * Thumbnail for a prompt image. Pass `src` for an already-available URL (optimistic local preview)
 * or `imageId` to fetch it from the session transcript once the thumbnail scrolls into view.
 */
export function ChatImageThumb({ src, imageId }: { src?: string; imageId?: string }) {
  const fetchImage = useFetchChatImage();
  const ref = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<ThumbState>(
    src ? { status: "ready", src } : { status: "idle" },
  );
  const [open, setOpen] = useState(false);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || src || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [src]);

  useEffect(() => {
    if (src || !imageId || !near) return;
    if (!fetchImage) {
      setState({ status: "error" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    cachedChatImage(imageId, () => fetchImage(imageId))
      .then((url) => !cancelled && setState({ status: "ready", src: url }))
      .catch(() => !cancelled && setState({ status: "error" }));
    return () => {
      cancelled = true;
    };
  }, [src, imageId, near, fetchImage]);

  const ready = state.status === "ready" ? state.src : null;
  return (
    <>
      <button
        ref={ref}
        type="button"
        disabled={!ready}
        onClick={() => setOpen(true)}
        aria-label="View attached image"
        className="w-16 h-16 rounded-md overflow-hidden border border-line-strong bg-surface flex items-center justify-center shrink-0 disabled:cursor-default"
      >
        {ready ? (
          <img src={ready} alt="Attached" className="w-full h-full object-cover" />
        ) : state.status === "error" ? (
          <ImageOff className="w-4 h-4 text-dim" />
        ) : (
          <Loader2 className="w-4 h-4 text-dim animate-spin" />
        )}
      </button>
      {open && ready && <ImageLightbox src={ready} onClose={() => setOpen(false)} />}
    </>
  );
}
