import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { elementScroll, useVirtualizer } from "@tanstack/react-virtual";
import { TURN_LIST_GAP_PX, estimateTimelineItemHeight } from "../../domain/chat/heightEstimator";
import type { ChatTimelineItem } from "../../domain/chat/types";

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function useChatScrollController({
  timeline,
  surfaceId,
  hasEarlier,
  isLoading,
  isLoadingOlder,
  onLoadOlder,
  isWorking,
  isSubmitting,
  isDesktop,
  onFollowingChange,
}: {
  timeline: readonly ChatTimelineItem[];
  surfaceId?: string;
  hasEarlier: boolean;
  isLoading: boolean;
  isLoadingOlder: boolean;
  onLoadOlder?: () => Promise<void>;
  isWorking: boolean;
  isSubmitting: boolean;
  isDesktop: boolean;
  onFollowingChange?: (following: boolean) => void;
}) {
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const isFollowingRef = useRef(true);
  const onFollowingChangeRef = useRef(onFollowingChange);
  const timelineRef = useRef(timeline);
  const programmaticUntilRef = useRef(0);
  const userGestureUntilRef = useRef(0);
  const pendingAnchorRef = useRef<number | null>(null);
  const isDesktopRef = useRef(isDesktop);

  useEffect(() => {
    timelineRef.current = timeline;
  }, [timeline]);

  useEffect(() => {
    onFollowingChangeRef.current = onFollowingChange;
  }, [onFollowingChange]);

  useEffect(() => {
    isDesktopRef.current = isDesktop;
    if (isDesktop) setIsKeyboardVisible(false);
  }, [isDesktop]);

  const updateFollowing = useCallback((next: boolean) => {
    if (isFollowingRef.current === next) return;
    isFollowingRef.current = next;
    onFollowingChangeRef.current?.(next);
  }, []);

  const markProgrammaticScroll = useCallback((durationMs = 200) => {
    programmaticUntilRef.current = Math.max(programmaticUntilRef.current, nowMs() + durationMs);
  }, []);

  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: timeline.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const item = timeline[index];
      return item ? estimateTimelineItemHeight(item, surfaceId) : 80;
    },
    getItemKey: (index) => timeline[index]?.id || `turn-${index}`,
    overscan: 6,
    gap: TURN_LIST_GAP_PX,
    scrollMargin,
    anchorTo: "end",
    followOnAppend: false,
    scrollEndThreshold: -1,
    scrollToFn: (offset, options, instance) => {
      markProgrammaticScroll();
      elementScroll(offset, options, instance);
    },
  });

  const updateScrollMargin = useCallback(() => {
    const scrollEl = scrollContainerRef.current;
    const sizerEl = sizerRef.current;
    if (!scrollEl || !sizerEl) {
      setScrollMargin((prev) => (prev === 0 ? prev : 0));
      return;
    }
    const next = Math.max(
      0,
      Math.round(
        sizerEl.getBoundingClientRect().top -
          scrollEl.getBoundingClientRect().top +
          scrollEl.scrollTop,
      ),
    );
    setScrollMargin((prev) => (prev === next ? prev : next));
  }, []);

  useLayoutEffect(() => {
    updateScrollMargin();
  }, [updateScrollMargin, hasEarlier, timeline.length]);

  const scrollToTail = useCallback(
    (behavior: ScrollBehavior = "instant") => {
      const container = scrollContainerRef.current;
      if (container) {
        markProgrammaticScroll(behavior === "smooth" ? 500 : 220);
        if (behavior !== "smooth" && timelineRef.current.length > 0) {
          virtualizer.scrollToEnd({ behavior: "auto" });
        }
        if (behavior === "smooth") {
          container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
        } else {
          container.scrollTop = container.scrollHeight;
        }
        return;
      }
      bottomAnchorRef.current?.scrollIntoView({ behavior, block: "end" });
    },
    [markProgrammaticScroll, virtualizer],
  );

  // Track explicit user scroll gestures so layout shifts / item re-measurements never detach `isFollowing`.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const markUserGesture = () => {
      userGestureUntilRef.current = nowMs() + 900;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "PageUp" ||
        e.key === "PageDown" ||
        e.key === "Home" ||
        e.key === "End" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === " "
      ) {
        markUserGesture();
      }
    };
    el.addEventListener("wheel", markUserGesture, { passive: true });
    el.addEventListener("touchmove", markUserGesture, { passive: true });
    el.addEventListener("pointerdown", markUserGesture, { passive: true });
    window.addEventListener("keydown", onKeyDown, { passive: true });
    return () => {
      el.removeEventListener("wheel", markUserGesture);
      el.removeEventListener("touchmove", markUserGesture);
      el.removeEventListener("pointerdown", markUserGesture);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useLayoutEffect(() => {
    if (!isFollowingRef.current) return;
    scrollToTail("instant");
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      if (!isFollowingRef.current) return;
      scrollToTail("instant");
      r2 = requestAnimationFrame(() => {
        if (isFollowingRef.current) scrollToTail("instant");
      });
    });
    return () => {
      cancelAnimationFrame(r1);
      if (r2) cancelAnimationFrame(r2);
    };
  }, [timeline.length, isWorking, isSubmitting, scrollToTail]);

  useEffect(() => {
    const contentEl = contentRef.current;
    const scrollEl = scrollContainerRef.current;
    if (!contentEl && !scrollEl) return;
    const observer = new ResizeObserver(() => {
      updateScrollMargin();
      if (isFollowingRef.current) scrollToTail("instant");
    });
    if (contentEl) observer.observe(contentEl);
    if (scrollEl) observer.observe(scrollEl);
    return () => observer.disconnect();
  }, [scrollToTail, updateScrollMargin]);

  const handleLoadEarlier = useCallback(() => {
    const container = scrollContainerRef.current;
    if (
      !container ||
      !hasEarlier ||
      isLoadingOlder ||
      pendingAnchorRef.current !== null ||
      !onLoadOlder
    ) {
      return;
    }
    pendingAnchorRef.current = container.scrollHeight - container.scrollTop;
    void onLoadOlder().finally(() => {
      requestAnimationFrame(() => {
        pendingAnchorRef.current = null;
      });
    });
  }, [hasEarlier, isLoadingOlder, onLoadOlder]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const anchor = pendingAnchorRef.current;
    if (!container || anchor === null) return;
    if (!isFollowingRef.current) {
      markProgrammaticScroll();
      container.scrollTop = Math.max(0, container.scrollHeight - anchor);
    }
    pendingAnchorRef.current = null;
  }, [timeline.length, markProgrammaticScroll]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || isLoading || isLoadingOlder || !hasEarlier) return;
    const id = requestAnimationFrame(() => {
      if (container.scrollHeight <= container.clientHeight + 60) handleLoadEarlier();
    });
    return () => cancelAnimationFrame(id);
  }, [timeline.length, hasEarlier, isLoading, isLoadingOlder, handleLoadEarlier]);

  // iOS Safari virtual keyboard tracking: strictly height-delta based, NEVER hijacking user scroll!
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const onViewportChange = () => {
      const vv = window.visualViewport;
      if (!vv) return;
      if (isDesktopRef.current) {
        setIsKeyboardVisible(false);
        return;
      }
      const keyboardOpen = window.innerHeight - vv.height > 100;
      setIsKeyboardVisible((prev) => (prev === keyboardOpen ? prev : keyboardOpen));
      if (keyboardOpen) {
        if (window.scrollY !== 0) window.scrollTo(0, 0);
        if (isFollowingRef.current) scrollToTail("instant");
      }
    };
    window.visualViewport.addEventListener("resize", onViewportChange);
    window.visualViewport.addEventListener("scroll", onViewportChange);
    onViewportChange();
    return () => {
      window.visualViewport?.removeEventListener("resize", onViewportChange);
      window.visualViewport?.removeEventListener("scroll", onViewportChange);
    };
  }, [scrollToTail]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const now = nowMs();
    if (now <= programmaticUntilRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceToBottom = scrollHeight - (scrollTop + clientHeight);
    const userInteracted = now <= userGestureUntilRef.current;

    if (distanceToBottom <= 60) {
      updateFollowing(true);
      setIsScrolledUp((prev) => (prev ? false : prev));
    } else if (distanceToBottom > 80 && (userInteracted || !isFollowingRef.current)) {
      updateFollowing(false);
      setIsScrolledUp((prev) => (prev ? prev : true));
    }

    if (
      scrollTop < 60 &&
      hasEarlier &&
      !isLoadingOlder &&
      (userInteracted || !isFollowingRef.current)
    ) {
      handleLoadEarlier();
    }
  }, [hasEarlier, isLoadingOlder, handleLoadEarlier, updateFollowing]);

  const handleJumpToTail = useCallback(() => {
    updateFollowing(true);
    setIsScrolledUp(false);
    scrollToTail("instant");
  }, [scrollToTail, updateFollowing]);

  return {
    virtualizer,
    scrollContainerRef,
    contentRef,
    sizerRef,
    bottomAnchorRef,
    scrollMargin,
    isScrolledUp,
    isKeyboardVisible,
    handleScroll,
    handleLoadEarlier,
    handleJumpToTail,
    scrollToTail,
  };
}
