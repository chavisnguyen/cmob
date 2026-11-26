import type { ReactNode } from "react";
import { Plus, QrCode } from "lucide-react";
import { surfaceIdentity, type MainTab } from "../../domain/workspaceTree";
import type { SavedHost } from "../../hosts/hostStore";
import type { SurfaceNode, UsageSnapshot, WorkspaceNode } from "../../protocol/rpc";
import { wsClient, type ConnectionState } from "../../transport/wsClient";
import { DeviceListView } from "../../views/DeviceListView";
import { SurfaceDetailView } from "../../views/SurfaceDetailView";
import { WorkspaceListView } from "../../views/WorkspaceListView";
import { DesktopTabStrip } from "../desktop/DesktopTabStrip";
import type { CreateSurfaceParams } from "../surface/NewSurfaceModal";
import { DesktopUsageWidget } from "../usage/DesktopUsageWidget";
import { UsageView } from "../usage/UsageView";
import { PrimaryTabNav } from "./PrimaryTabNav";

export interface DesktopWorkspaceShellProps {
  topHeader: ReactNode;
  mainTab: MainTab;
  onSelectMainTab: (tab: MainTab) => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  workspaces: WorkspaceNode[];
  loading: boolean;
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
  return (
    <>
      {!sidebarCollapsed && (
        <aside
          aria-label="Workspaces sidebar"
          className="w-[350px] xl:w-[380px] shrink-0 h-full flex flex-col bg-bg border-r border-line overflow-hidden"
        >
          {topHeader}
          <div className="flex-1 min-h-0 overflow-hidden">
            <WorkspaceListView
              workspaces={workspaces}
              loading={loading}
              onRefresh={onRefreshWorkspaces}
              onSelectWorkspace={onSelectWorkspace}
              hostsCount={hosts.length}
              connState={connState}
              onPairHost={onOpenPairModal}
              selectedWorkspaceId={mainTab === "workspaces" ? selectedWorkspace?.id : null}
              hideOnboarding
            />
          </div>
          <PrimaryTabNav mainTab={mainTab} onSelectTab={onSelectMainTab} />
        </aside>
      )}

      <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-bg">
        <DesktopTabStrip
          workspace={mainTab === "workspaces" ? selectedWorkspace : null}
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
          usageWidget={
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
          }
        />

        {connState === "error" && errorMessage && (
          <div className="mx-4 mt-2 px-3.5 py-2 rounded-xl bg-rose-500/15 border border-rose-500/25 text-rose-300 text-[12.5px] flex items-center justify-between gap-2 shrink-0">
            <span className="leading-tight">{errorMessage}</span>
            <button
              type="button"
              onClick={() => wsClient.connect()}
              className="px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 text-[11.5px] font-semibold shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-hidden">
          {mainTab === "usage" ? (
            <UsageView
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
          ) : mainTab === "devices" ? (
            <DeviceListView
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
          ) : hasNoHosts && !loading ? (
            <div className="h-full flex flex-col items-center justify-center px-6 py-16 text-center">
              <h2 className="text-[22px] font-bold text-white tracking-tight mb-2">
                Welcome to Cmob
              </h2>
              <p className="text-[14px] text-muted max-w-md leading-relaxed mb-6">
                Connect your computer to monitor terminal workspaces and control coding agents like
                Claude Code, AGY, and Kiro.
              </p>
              <button
                type="button"
                onClick={onOpenPairModal}
                className="inline-flex items-center gap-2 px-5 min-h-[44px] rounded-xl bg-accent hover:bg-accent-strong text-white text-[14px] font-semibold transition-colors cursor-pointer"
              >
                <QrCode className="w-4 h-4" />
                <span>Connect Your Computer</span>
              </button>
              <code className="mt-5 text-[12.5px] text-emerald-400">$ cmob qr --tailscale</code>
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
            />
          ) : selectedWorkspace ? (
            <div className="h-full flex flex-col items-center justify-center gap-4 px-6 text-center text-muted">
              <p className="text-[14px]">
                No terminal tabs open in{" "}
                <span className="text-fg font-medium">{selectedWorkspace.title}</span>.
              </p>
              <button
                type="button"
                onClick={() => onOpenNewSurface(selectedWorkspace)}
                className="h-10 px-4 rounded-xl bg-accent hover:bg-accent-strong text-white text-[14px] font-semibold inline-flex items-center gap-2 transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span>Open First Tab</span>
              </button>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center px-6 text-center text-[14px] text-muted">
              {loading ? "Loading workspaces…" : "Select a workspace from the sidebar."}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
