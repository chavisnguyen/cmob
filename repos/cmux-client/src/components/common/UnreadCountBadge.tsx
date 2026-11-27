interface UnreadCountBadgeProps {
  count?: number;
  size?: "sm" | "md";
  className?: string;
}

/**
 * High-contrast monochrome counter pill matching Raycast / macOS source-list badges.
 */
export function UnreadCountBadge({
  count = 0,
  size = "md",
  className = "",
}: UnreadCountBadgeProps) {
  if (!count || count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  const dims =
    size === "sm"
      ? "min-w-[16px] h-[15px] px-1 text-[10px]"
      : "min-w-[18px] h-[17px] px-1.5 text-[11px]";

  return (
    <span
      data-testid="unread-count-badge"
      aria-label={`${count} unread ${count === 1 ? "notification" : "notifications"}`}
      className={`inline-flex items-center justify-center rounded-full bg-accent text-bg font-semibold leading-none tabular-nums shrink-0 ${dims} ${className}`.trim()}
    >
      {label}
    </span>
  );
}
