import { X } from "lucide-react";
import { plainNotificationBody } from "../../domain/notificationCenter";
import type { NotificationAlertPayload } from "../../protocol/rpc";

export function ToastOverlay({
  toasts,
  onSelectToast,
  onDismissToast,
}: {
  toasts: NotificationAlertPayload[];
  onSelectToast: (toast: NotificationAlertPayload) => void;
  onDismissToast: (notificationId: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-[calc(0.75rem+env(safe-area-inset-top,0px))] right-3 left-3 sm:left-auto sm:w-96 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.notification_id}
          className={`pointer-events-auto flex items-start gap-2.5 rounded-2xl bg-raised border border-line border-l-[3px] pl-3 pr-2 py-2.5 shadow-lg ${
            toast.category === "agent-error"
              ? "border-l-rose-400"
              : toast.urgent || toast.category === "needs-permission"
                ? "border-l-amber-400"
                : "border-l-accent"
          }`}
        >
          <button
            type="button"
            onClick={() => onSelectToast(toast)}
            className="flex-1 min-w-0 text-left"
          >
            <div className="text-[13px] font-semibold leading-snug truncate">{toast.title}</div>
            <div className="text-[12.5px] text-fg-soft leading-snug line-clamp-2 mt-0.5">
              {plainNotificationBody(toast.body)}
            </div>
          </button>
          <button
            type="button"
            onClick={() => onDismissToast(toast.notification_id)}
            className="w-7 h-7 rounded-lg hover:bg-white/[0.1] text-muted hover:text-white flex items-center justify-center shrink-0"
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
