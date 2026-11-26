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
    <div className="fixed top-[calc(0.75rem+env(safe-area-inset-top,0px))] right-3 left-3 sm:left-auto sm:w-88 z-50 flex flex-col gap-1.5 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.notification_id}
          className={`pointer-events-auto flex items-start gap-2 rounded-lg bg-surface border border-line-strong border-l-[2px] pl-3 pr-2 py-2 shadow-xl ${
            toast.category === "agent-error"
              ? "border-l-status-err"
              : toast.urgent || toast.category === "needs-permission"
                ? "border-l-status-wait"
                : "border-l-fg"
          }`}
        >
          <button
            type="button"
            onClick={() => onSelectToast(toast)}
            className="flex-1 min-w-0 text-left"
          >
            <div className="text-[12.5px] font-semibold text-fg leading-snug truncate">
              {toast.title}
            </div>
            <div className="text-[12px] text-muted leading-snug line-clamp-2 mt-0.5">
              {plainNotificationBody(toast.body)}
            </div>
          </button>
          <button
            type="button"
            onClick={() => onDismissToast(toast.notification_id)}
            className="w-6 h-6 rounded hover:bg-raised text-dim hover:text-fg flex items-center justify-center shrink-0"
            aria-label="Dismiss notification"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
