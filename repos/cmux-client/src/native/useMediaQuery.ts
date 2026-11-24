import { useEffect, useState } from "react";

const DESKTOP_QUERY = "(min-width: 1024px)";

function readMatches(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(query).matches;
}

/** Subscribes to a CSS media query; returns false in SSR/static test environments. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => readMatches(query));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** True on desktop-width viewports (>= 1024px, matching Tailwind's `lg:` breakpoint). */
export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}
