import { type ReactElement } from "react";
import { LayoutGrid, Server, Settings, type LucideIcon } from "lucide-react";
import { haptic } from "../../native/haptics";

export type MainNavTab = "workspaces" | "devices" | "settings";

interface TabConfig {
  id: MainNavTab;
  label: string;
  icon: LucideIcon;
}

const TABS: TabConfig[] = [
  {
    id: "workspaces",
    label: "Workspaces",
    icon: LayoutGrid,
  },
  {
    id: "devices",
    label: "Devices",
    icon: Server,
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
  },
];

export function BottomTabBar({
  activeTab,
  onSelectTab,
  workspaceBadge = 0,
}: {
  activeTab: MainNavTab;
  onSelectTab: (tab: MainNavTab) => void;
  workspaceBadge?: number;
}): ReactElement {
  return (
    <nav
      role="navigation"
      aria-label="Bottom Navigation"
      className="fixed bottom-0 left-0 right-0 z-40 bg-[#121215]/95 backdrop-blur-md border-t border-white/[0.08] px-3 pt-1.5 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] select-none"
    >
      <div role="tablist" aria-label="Main views" className="flex items-center justify-around">
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          const Icon = tab.icon;
          const badge = tab.id === "workspaces" ? workspaceBadge : 0;

          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => {
                if (!isActive) {
                  haptic("light");
                  onSelectTab(tab.id);
                }
              }}
              className={`flex flex-col items-center justify-center flex-1 min-h-[44px] py-1 rounded-xl transition-all cursor-pointer ${
                isActive ? "text-[#fafafa]" : "text-[#a1a1aa] hover:text-[#e4e4e7]"
              }`}
            >
              <div className="relative flex items-center justify-center">
                <Icon
                  className={`w-5 h-5 transition-transform ${
                    isActive ? "text-[#8ab4f8] scale-105" : "text-current"
                  }`}
                />
                {badge > 0 && (
                  <span className="absolute -top-1 -right-2.5 px-1.5 py-0.5 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-rose-500 text-white font-semibold text-[10px] leading-none shadow-sm">
                    {badge > 9 ? "9+" : badge}
                  </span>
                )}
              </div>
              <span
                className={`text-[11px] font-medium mt-1 leading-tight tracking-tight ${
                  isActive ? "text-[#fafafa] font-semibold" : "text-[#a1a1aa]"
                }`}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
