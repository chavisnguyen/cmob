import { FolderGit2, Gauge, Server } from "lucide-react";
import type { MainTab } from "../../domain/workspaceTree";
import { haptic } from "../../native/haptics";

export function PrimaryTabNav({
  mainTab,
  onSelectTab,
}: {
  mainTab: MainTab;
  onSelectTab: (tab: MainTab) => void;
}) {
  return (
    <nav
      aria-label="Primary navigation"
      className="shrink-0 grid grid-cols-3 bg-surface border-t border-line pt-1.5 pb-[max(env(safe-area-inset-bottom,0px),8px)] select-none"
    >
      {[
        { id: "workspaces" as const, label: "Workspaces", icon: FolderGit2 },
        { id: "usage" as const, label: "Usage", icon: Gauge },
        { id: "devices" as const, label: "Devices", icon: Server },
      ].map(({ id, label, icon: Icon }) => {
        const selected = mainTab === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => {
              haptic("light");
              onSelectTab(id);
            }}
            aria-current={selected ? "page" : undefined}
            className={`flex flex-col items-center justify-center gap-0.5 py-1 transition-colors ${
              selected ? "text-fg" : "text-muted hover:text-fg-soft"
            }`}
          >
            <Icon className={`w-5 h-5 ${selected ? "text-accent-soft" : ""}`} />
            <span className="text-[11px] font-medium">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
