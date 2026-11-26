interface UnreadCountBadgeProps {
  count?: number;
  size?: "sm" | "md";
  className?: string;
}

/**
 * Native cmux-style solid `#0A84FF` unread notification count pill (`1`, `2`, ..., `99+`).
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
      ? "min-w-[16px] h-[16px] px-1 text-[10.5px]"
      : "min-w-[19px] h-[19px] px-1.5 text-[11.5px]";

  return (
    <span
      data-testid="unread-count-badge"
      aria-label={`${count} unread ${count === 1 ? "notification" : "notifications"}`}
      className={`inline-flex items-center justify-center rounded-full bg-[#0A84FF] text-white font-bold leading-none tabular-nums shrink-0 shadow-xs ${dims} ${className}`.trim()}
    >
      {label}
    </span>
  );
}
