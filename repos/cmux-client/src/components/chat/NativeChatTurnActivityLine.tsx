import React from "react";
import { Loader2 } from "lucide-react";

interface NativeChatTurnActivityLineProps {
  activityText?: string | null;
  stopping?: boolean;
}

/**
 * Orca-style Live Turn Activity Line
 * Matches: ref/orca/src/renderer/src/components/native-chat/messages/reasoning/NativeChatTurnActivityLine.tsx
 * - Renders an immediate live status spinner right after the user's prompt or below active in-flight steps.
 * - Prevents the "dead silence" feeling where users wait with no feedback until the agent outputs a full block.
 */
export function NativeChatTurnActivityLine({
  activityText,
  stopping = false,
}: NativeChatTurnActivityLineProps): React.JSX.Element {
  const label = stopping ? "Stopping…" : activityText || "Thinking…";

  return (
    <div
      className="flex items-center gap-2 py-1.5 px-1 text-[12.5px] text-muted select-none"
      data-native-chat-turn-activity="true"
      aria-live="polite"
      aria-atomic="true"
    >
      <Loader2 className="w-3.5 h-3.5 animate-spin text-muted shrink-0" />
      <span className="text-muted font-sans truncate">{label}</span>
    </div>
  );
}
