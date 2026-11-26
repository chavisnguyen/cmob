import { useEffect } from "react";
import { Laptop, Monitor, Plus, Server, Settings2, X, type LucideIcon } from "lucide-react";
import { classifyHostType, type HostMachineType, type SavedHost } from "../../hosts/hostStore";
import type { ConnectionState } from "../../transport/wsClient";
import { Pressable } from "../common/Pressable";

const GLYPHS: Record<HostMachineType, LucideIcon> = {
  laptop: Laptop,
  desktop: Monitor,
  server: Server,
};

interface HostSwitchSheetProps {
  hosts: SavedHost[];
  activeHostId: string;
  connState: ConnectionState;
  onSelect: (host: SavedHost) => void;
  onAdd: () => void;
  onManage: () => void;
  onClose: () => void;
}

export function HostSwitchSheet({
  hosts,
  activeHostId,
  connState,
  onSelect,
  onAdd,
  onManage,
  onClose,
}: HostSwitchSheetProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const tone =
    connState === "connected"
      ? "text-status-ok"
      : connState === "connecting" || connState === "authenticating"
        ? "text-status-wait"
        : "text-status-err";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center md:p-4 bg-black/65 backdrop-blur-[1px] animate-fade-in"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Switch computer"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl md:max-w-md mx-auto max-h-[70vh] flex flex-col rounded-t-xl md:rounded-xl bg-surface border-t md:border border-line-strong shadow-2xl pb-[env(safe-area-inset-bottom,0px)] md:pb-0 overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 h-11 bg-sidebar border-b border-line shrink-0">
          <h2 className="text-[13.5px] font-semibold text-fg">Computers · {hosts.length}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 rounded-md text-muted hover:text-fg hover:bg-raised flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto py-1 divide-y divide-line/60 bg-bg">
          {hosts.map((host) => {
            const active = host.id === activeHostId;
            const Icon = GLYPHS[classifyHostType(host.name || host.endpoint)];
            return (
              <Pressable
                key={host.id}
                onPress={() => {
                  onSelect(host);
                  onClose();
                }}
                className={`flex items-center gap-3 px-4 min-h-[48px] cursor-pointer transition-colors ${
                  active ? "bg-raised" : "hover:bg-surface/70 active:bg-surface"
                }`}
              >
                <Icon className="w-4 h-4 text-muted shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium text-fg truncate">{host.name}</div>
                  <div className="text-[11.5px] text-dim font-mono truncate">{host.endpoint}</div>
                </div>
                {active && (
                  <span className={`text-[11.5px] font-medium capitalize shrink-0 ${tone}`}>
                    {connState}
                  </span>
                )}
              </Pressable>
            );
          })}
        </div>
        <div className="flex gap-2 p-2.5 bg-sidebar border-t border-line">
          <button
            type="button"
            onClick={() => {
              onAdd();
              onClose();
            }}
            className="flex-1 h-9 rounded-lg bg-fg hover:bg-accent-strong text-bg text-[12.5px] font-medium flex items-center justify-center gap-1.5 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Computer</span>
          </button>
          <button
            type="button"
            onClick={() => {
              onManage();
              onClose();
            }}
            className="flex-1 h-9 rounded-lg bg-raised hover:bg-line-strong text-fg text-[12.5px] font-medium flex items-center justify-center gap-1.5 transition-colors"
          >
            <Settings2 className="w-3.5 h-3.5" />
            <span>Manage</span>
          </button>
        </div>
      </div>
    </div>
  );
}
