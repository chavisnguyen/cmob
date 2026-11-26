import { lazy, Suspense, type ReactNode } from "react";
import { FolderGit2, Gauge, Plus, QrCode, Server } from "lucide-react";
import { surfaceIdentity, type MainTab } from "../../domain/workspaceTree";
import type { SavedHost } from "../../hosts/hostStore";
import type { SurfaceNode, UsageSnapshot, WorkspaceNode } from "../../protocol/rpc";
import { wsClient, type ConnectionState } from "../../transport/wsClient";
import { SurfaceDetailView } from "../../views/SurfaceDetailView";
import { WorkspaceListView } from "../../views/WorkspaceListView";
import { UnreadCountBadge } from "../common/UnreadCountBadge";
import { DesktopTabStrip } from "../desktop/DesktopTabStrip";
import type { CreateSurfaceParams } from "../surface/NewSurfaceModal";
import { DesktopUsageWidget } from "../usage/DesktopUsageWidget";

const LazyUsageView = lazy(() =>
  import("../usage/UsageView").then((m) => ({ default: m.UsageView })),
);
const LazyDeviceListView = lazy(() =>
  import("../../views/DeviceListView").then((m) => ({ default: m.DeviceListView })),
);

export interface DesktopWorkspaceShellProps {
  topHeader: ReactNode;
  mainTab: MainTab;
  onSelectMainTab: (tab: MainTab) => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  workspaces: WorkspaceNode[];
  loading: boolean;
  syncing?: boolean;
  totalUnread?: number;
  selectedWorkspace: WorkspaceNode | null;
  selectedSurface: SurfaceNode | null;
  hosts: SavedHost[];
  activeHostId: string;
  activeHost: SavedHost | null;
  connState: ConnectionState;
  hasNoHosts: boolean;
  errorMessage: string | null;
  usage: {
    snapshot: UsageSnapshot | null;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
    unsupported: boolean;
    now: number;
    refresh: () => Promise<void>;
  };
  onRefreshWorkspaces: () => void;
  onSelectWorkspace: (ws: WorkspaceNode) => void;
  onSelectSurface: (surf: SurfaceNode) => void;
  onBackToSurfaces: () => void;
  onOpenPairModal: () => void;
  onOpenNewSurface: (ws: WorkspaceNode) => void;
  onRequestCloseSurface: (ws: WorkspaceNode, surf: SurfaceNode) => void;
  onOpenChanges: (ws: WorkspaceNode) => void;
  onSwitchHost: (host: SavedHost) => void;
  onRemoveHost: (id: string) => void;
  onRenameHost: (id: string, name: string) => void;
  onCreateSurface: (params: CreateSurfaceParams) => Promise<void>;
  onRenameSurface: (surfaceId: string, title: string) => Promise<void>;
  onCloseSurface: (surfaceId: string, workspaceId?: string) => Promise<void>;
}

export function DesktopWorkspaceShell({
  topHeader,
  mainTab,
  onSelectMainTab,
  sidebarCollapsed,
  onToggleSidebar,
  workspaces,
  loading,
  syncing = false,
  totalUnread = 0,
  selectedWorkspace,
  selectedSurface,
  hosts,
  activeHostId,
  activeHost,
  connState,
  hasNoHosts,
  errorMessage,
  usage,
  onRefreshWorkspaces,
  onSelectWorkspace,
  onSelectSurface,
  onBackToSurfaces,
  onOpenPairModal,
  onOpenNewSurface,
  onRequestCloseSurface,
  onOpenChanges,
  onSwitchHost,
  onRemoveHost,
  onRenameHost,
  onCreateSurface,
  onRenameSurface,
  onCloseSurface,
}: DesktopWorkspaceShellProps) {
  const usageWidget = (
    <DesktopUsageWidget
      hostName={activeHost?.name ?? "No computer"}
      connState={connState}
      snapshot={usage.snapshot}
      loading={usage.loading}
      refreshing={usage.refreshing}
      error={usage.error}
      unsupported={usage.unsupported}
      now={usage.now}
      onRefresh={() => void usage.refresh()}
    />
  );

  const showingSurfaceDetail =
    mainTab === "workspaces" && !hasNoHosts && Boolean(selectedWorkspace && selectedSurface);

  return (
    <>
      {!sidebarCollapsed && (
        <aside
          aria-label="Workspaces sidebar"
          className="w-[264px] xl:w-[284px] shrink-0 h-full flex flex-col bg-sidebar border-r border-line overflow-hidden select-none"
        >
          {topHeader}
          <div className="flex-1 min-h-0 overflow-hidden">
            <WorkspaceListView
              workspaces={workspaces}
              loading={loading}
              syncing={syncing}
              onRefresh={onRefreshWorkspaces}
              onSelectWorkspace={(ws) => {
                onSelectWorkspace(ws);
                if (mainTab !== "workspaces") onSelectMainTab("workspaces");
              }}
              hostsCount={hosts.length}
              connState={connState}
              onPairHost={onOpenPairModal}
              selectedWorkspaceId={mainTab === "workspaces" ? selectedWorkspace?.id : null}
              hideOnboarding
            />
          </div>

          <footer
            aria-label="Sidebar navigation"
            className="h-[34px] shrink-0 px-2 border-t border-line bg-sidebar flex items-center justify-between gap-1"
          >
            <div className="flex items-center gap-0.5">
              {[
                { id: "workspaces" as const, label: "Workspaces", icon: FolderGit2 },
                { id: "usage" as const, label: "Usage", icon: Gauge },
                { id: "devices" as const, label: "Hosts", icon: Server },
              ].map(({ id, label, icon: Icon }) => {
                const active = mainTab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onSelectMainTab(id)}
                    aria-current={active ? "page" : undefined}
                    className={`h-[24px] px-2 rounded-[5px] text-[11.5px] font-medium inline-flex items-center gap-1.5 transition-colors ${
                      active
                        ? "bg-raised text-fg"
                        : "text-muted hover:text-fg-soft hover:bg-surface"
                    }`}
                  >
                    <Icon className="w-3 h-3 shrink-0" />
                    <span>{label}</span>
                    {id === "workspaces" && totalUnread > 0 && (
                      <UnreadCountBadge count={totalUnread} size="sm" />
                    )}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={onOpenPairModal}
              title="Pair computer"
              aria-label="Pair computer"
              className="w-[24px] h-[24px] rounded-[5px] text-dim hover:text-fg hover:bg-raised flex items-center justify-center transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </footer>
        </aside>
      )}

      <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-bg">
        {!showingSurfaceDetail && (
          <DesktopTabStrip
            workspace={mainTab === "workspaces" ? selectedWorkspace : null}
            sectionTitle={
              mainTab === "usage"
                ? "Model Usage"
                : mainTab === "devices"
                  ? "Hosts & Devices"
                  : undefined
            }
            surfaces={selectedWorkspace?.surfaces ?? []}
            activeSurface={selectedSurface}
            sidebarCollapsed={sidebarCollapsed}
            loading={loading}
            onToggleSidebar={onToggleSidebar}
            onSelectSurface={onSelectSurface}
            onNewSurface={() => {
              if (selectedWorkspace) onOpenNewSurface(selectedWorkspace);
            }}
            onCloseSurface={(surf) => {
              if (selectedWorkspace) onRequestCloseSurface(selectedWorkspace, surf);
            }}
            onOpenChanges={() => {
              if (selectedWorkspace) onOpenChanges(selectedWorkspace);
            }}
            onRefresh={onRefreshWorkspaces}
            usageWidget={usageWidget}
          />
        )}

        {connState === "error" && errorMessage && (
          <div className="mx-4 mt-2 px-3 py-1.5 rounded-lg bg-status-err/10 border border-status-err/25 text-status-err text-[12px] flex items-center justify-between gap-2 shrink-0">
            <span className="leading-tight">{errorMessage}</span>
            <button
              type="button"
              onClick={() => wsClient.connect()}
              className="px-2 py-0.5 rounded bg-status-err/15 hover:bg-status-err/25 text-fg text-[11px] font-medium shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-hidden">
          {mainTab === "usage" ? (
            <Suspense fallback={<div className="h-full bg-bg" />}>
              <LazyUsageView
                hostName={activeHost?.name ?? "No computer"}
                connState={connState}
                snapshot={usage.snapshot}
                loading={usage.loading}
                refreshing={usage.refreshing}
                error={usage.error}
                unsupported={usage.unsupported}
                now={usage.now}
                hideHeader
                onRefresh={() => void usage.refresh()}
              />
            </Suspense>
          ) : mainTab === "devices" ? (
            <Suspense fallback={<div className="h-full bg-bg" />}>
              <LazyDeviceListView
                hosts={hosts}
                activeHostId={activeHostId}
                connState={connState}
                hideBack
                onSelectHost={(h) => {
                  onSwitchHost(h);
                  onSelectMainTab("workspaces");
                }}
                onRemoveHost={onRemoveHost}
                onRenameHost={onRenameHost}
                onBack={() => onSelectMainTab("workspaces")}
              />
            </Suspense>
          ) : hasNoHosts && !loading ? (
            <div className="h-full flex flex-col items-center justify-center px-6 py-16 text-center">
              <h2 className="text-[18px] font-semibold text-fg tracking-tight mb-1.5">
                Welcome to Cmob
              </h2>
              <p className="text-[13px] text-muted max-w-md leading-relaxed mb-5">
                Connect your Mac to monitor cmux workspaces and control Claude Code, Antigravity,
                Codex, and Kiro.
              </p>
              <button
                type="button"
                onClick={onOpenPairModal}
                className="inline-flex items-center gap-2 px-4 h-9 rounded-lg bg-fg hover:bg-accent-strong text-bg text-[13px] font-medium transition-colors cursor-pointer"
              >
                <QrCode className="w-3.5 h-3.5" />
                <span>Connect Your Computer</span>
              </button>
              <code className="mt-4 text-[12px] text-muted font-mono bg-surface border border-line px-2.5 py-1 rounded-md">
                $ cmob qr --tailscale
              </code>
            </div>
          ) : selectedWorkspace && selectedSurface ? (
            <SurfaceDetailView
              key={surfaceIdentity(selectedSurface)}
              surface={selectedSurface}
              workspace={selectedWorkspace}
              onBack={onBackToSurfaces}
              allSurfaces={selectedWorkspace.surfaces}
              onSelectSurface={onSelectSurface}
              onCreateSurface={onCreateSurface}
              onRenameSurface={onRenameSurface}
              onCloseSurface={(id) => onCloseSurface(id, selectedWorkspace.id)}
              onRefresh={onRefreshWorkspaces}
              desktopLayout
              desktopChrome={{
                sidebarCollapsed,
                loading,
                onToggleSidebar,
                onOpenNewSurface: () => onOpenNewSurface(selectedWorkspace),
                onRequestCloseSurface: (surf) => onRequestCloseSurface(selectedWorkspace, surf),
                onOpenChanges: () => onOpenChanges(selectedWorkspace),
                usageWidget,
              }}
            />
          ) : selectedWorkspace ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center text-muted">
              <p className="text-[13px]">
                No tabs open in{" "}
                <span className="text-fg font-medium">{selectedWorkspace.title}</span>.
              </p>
              <button
                type="button"
                onClick={() => onOpenNewSurface(selectedWorkspace)}
                className="h-8 px-3.5 rounded-lg bg-fg hover:bg-accent-strong text-bg text-[12.5px] font-medium inline-flex items-center gap-1.5 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Tab</span>
              </button>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center px-6 text-center text-[13px] text-muted">
              {loading ? "Loading workspaces…" : "Select a workspace from the sidebar."}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
