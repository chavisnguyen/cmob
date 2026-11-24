import { useEffect } from "react";
import { Laptop, Monitor, Plus, Server, Settings2, X, type LucideIcon } from "lucide-react";
import { Pressable } from "../common/Pressable";
import { classifyHostType, type HostMachineType, type SavedHost } from "../../hosts/hostStore";
import type { ConnectionState } from "../../transport/wsClient";

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

/** Bottom sheet to switch between paired computers; opened from the connection pill in the header. */
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
      ? "text-emerald-400"
      : connState === "connecting" || connState === "authenticating"
        ? "text-amber-400"
        : "text-rose-400";
  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center md:p-4 bg-black/60 backdrop-blur-[1px] animate-fade-in"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Switch computer"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl md:max-w-md mx-auto max-h-[70vh] flex flex-col rounded-t-2xl md:rounded-2xl bg-bg border-t md:border border-white/[0.1] shadow-2xl pb-[env(safe-area-inset-bottom,0px)] md:pb-0"
      >
        <div className="flex items-center justify-between px-4 h-12 border-b border-white/[0.08] shrink-0">
          <h2 className="text-[15px] font-semibold">Computers · {hosts.length}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 rounded-xl text-muted hover:bg-raised flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto py-1">
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
                className={`flex items-center gap-3 px-4 min-h-[56px] cursor-pointer ${
                  active ? "bg-accent/12" : "active:bg-white/[0.05]"
                }`}
              >
                <div className="w-9 h-9 rounded-[10px] bg-surface border border-white/[0.07] flex items-center justify-center shrink-0">
                  <Icon className="w-4 h-4 text-muted" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[14.5px] font-medium truncate">{host.name}</div>
                  <div className="text-[12.5px] text-muted font-mono truncate">{host.endpoint}</div>
                </div>
                {active && (
                  <span className={`text-[12px] font-medium capitalize shrink-0 ${tone}`}>
                    {connState}
                  </span>
                )}
              </Pressable>
            );
          })}
        </div>
        <div className="flex gap-2 mx-4 my-3">
          <button
            type="button"
            onClick={() => {
              onAdd();
              onClose();
            }}
            className="flex-1 h-11 rounded-xl bg-raised hover:bg-line text-[14px] font-medium flex items-center justify-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>Add computer</span>
          </button>
          <button
            type="button"
            onClick={() => {
              onManage();
              onClose();
            }}
            className="flex-1 h-11 rounded-xl bg-raised hover:bg-line text-[14px] font-medium flex items-center justify-center gap-1.5"
          >
            <Settings2 className="w-4 h-4" />
            <span>Manage</span>
          </button>
        </div>
      </div>
    </div>
  );
}
