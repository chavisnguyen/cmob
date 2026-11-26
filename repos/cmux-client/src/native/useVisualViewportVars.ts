import { useEffect } from "react";

/**
 * Tracks `window.visualViewport` so `--app-height` and `--app-top` keep the fixed `#root`
 * pinned directly above the iOS / Android virtual keyboard without freezing when zoomed.
 */
export function useVisualViewportVars(): void {
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;

    const preventWindowScroll = () => {
      if (window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    };

    const updateViewportVars = () => {
      const vv = window.visualViewport;
      if (!vv) return;
      document.documentElement.style.setProperty("--app-height", `${vv.height}px`);
      document.documentElement.style.setProperty("--app-top", `${vv.offsetTop}px`);
      preventWindowScroll();
    };

    window.visualViewport.addEventListener("resize", updateViewportVars);
    window.visualViewport.addEventListener("scroll", updateViewportVars);
    window.addEventListener("scroll", preventWindowScroll, { passive: true });
    updateViewportVars();

    return () => {
      window.visualViewport?.removeEventListener("resize", updateViewportVars);
      window.visualViewport?.removeEventListener("scroll", updateViewportVars);
      window.removeEventListener("scroll", preventWindowScroll);
    };
  }, []);
}
