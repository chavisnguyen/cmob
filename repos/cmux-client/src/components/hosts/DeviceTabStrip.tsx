import { useEffect, useRef, type ReactElement } from "react";
import { Laptop, Monitor, Plus, Server, type LucideIcon } from "lucide-react";
import { classifyHostType, type HostMachineType, type SavedHost } from "../../hosts/hostStore";
import type { ConnectionState } from "../../transport/wsClient";
import { haptic } from "../../native/haptics";

const GLYPHS: Record<HostMachineType, LucideIcon> = {
  laptop: Laptop,
  desktop: Monitor,
  server: Server,
};

export function DeviceTabStrip({
  hosts,
  activeHostId,
  connState,
  onSelectHost,
  onAddHost,
}: {
  hosts: SavedHost[];
  activeHostId: string;
  connState: ConnectionState;
  onSelectHost: (host: SavedHost) => void;
  onAddHost: () => void;
}): ReactElement {
  const activeTabRef = useRef<HTMLButtonElement | null>(null);

  // Auto-scroll the active device tab into view smoothly
  useEffect(() => {
    if (activeTabRef.current) {
      activeTabRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
    }
  }, [activeHostId]);

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = hosts[(index + 1) % hosts.length];
      if (next) {
        haptic("light");
        onSelectHost(next);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const prev = hosts[(index - 1 + hosts.length) % hosts.length];
      if (prev) {
        haptic("light");
        onSelectHost(prev);
      }
    }
  };

  return (
    <div className="relative flex items-center bg-[#111114] border-b border-white/[0.08] shrink-0 select-none">
      <div
        role="tablist"
        aria-label="Devices"
        className="flex items-center gap-1.5 px-3 py-1.5 overflow-x-auto no-scrollbar scroll-smooth flex-1 min-w-0"
      >
        {hosts.map((host, idx) => {
          const isActive = host.id === activeHostId;
          const machineType = classifyHostType(host.name || host.endpoint);
          const Icon = GLYPHS[machineType];

          return (
            <button
              key={host.id}
              ref={isActive ? activeTabRef : null}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => {
                haptic("light");
                onSelectHost(host);
              }}
              onKeyDown={(e) => handleKeyDown(e, idx)}
              className={`flex items-center gap-2 min-h-[36px] px-3 rounded-xl text-[12.5px] font-medium transition-all shrink-0 cursor-pointer ${
                isActive
                  ? "bg-[#24242c] text-[#fafafa] font-semibold border border-white/[0.14] shadow-sm"
                  : "bg-white/[0.03] text-[#a1a1aa] hover:text-[#fafafa] hover:bg-white/[0.06] border border-white/[0.04]"
              }`}
            >
              <Icon
                className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-[#8ab4f8]" : "text-[#71717a]"}`}
              />
              <span className="truncate max-w-[120px] sm:max-w-[160px]">{host.name}</span>
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  isActive
                    ? connState === "connected"
                      ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]"
                      : connState === "connecting" || connState === "authenticating"
                        ? "bg-amber-400 animate-pulse"
                        : "bg-rose-400"
                    : "bg-white/20"
                }`}
              />
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => {
            haptic("light");
            onAddHost();
          }}
          className="flex items-center gap-1.5 min-h-[36px] px-2.5 rounded-xl border border-dashed border-white/[0.16] hover:border-white/[0.3] text-[#a1a1aa] hover:text-white bg-transparent hover:bg-white/[0.04] text-[12px] font-medium shrink-0 transition-colors cursor-pointer"
          title="Pair new device"
          aria-label="Pair new device"
        >
          <Plus className="w-3.5 h-3.5" />
          <span className="text-[12px]">Add</span>
        </button>
      </div>
    </div>
  );
}
