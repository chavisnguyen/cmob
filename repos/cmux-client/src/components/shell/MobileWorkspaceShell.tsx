import { surfaceIdentity, type AppView, type MainTab } from "../../domain/workspaceTree";
import type { SavedHost } from "../../hosts/hostStore";
import type { SurfaceNode, UsageSnapshot, WorkspaceNode } from "../../protocol/rpc";
import type { ConnectionState } from "../../transport/wsClient";
import { DeviceListView } from "../../views/DeviceListView";
import { SurfaceDetailView } from "../../views/SurfaceDetailView";
import { SurfaceListView } from "../../views/SurfaceListView";
import { WorkspaceListView } from "../../views/WorkspaceListView";
import type { CreateSurfaceParams } from "../surface/NewSurfaceModal";
import { UsageView } from "../usage/UsageView";
import { PrimaryTabNav } from "./PrimaryTabNav";

export interface MobileWorkspaceShellProps {
  mainTab: MainTab;
  onSelectMainTab: (tab: MainTab) => void;
  activeView: AppView;
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
  onBackToWorkspaces: () => void;
  onBackToSurfaces: () => void;
  onOpenPairModal: () => void;
  onSwitchHost: (host: SavedHost) => void;
  onRemoveHost: (id: string) => void;
  onRenameHost: (id: string, name: string) => void;
  onCreateSurface: (params: CreateSurfaceParams) => Promise<void>;
  onRenameSurface: (surfaceId: string, title: string) => Promise<void>;
  onCloseSurface: (surfaceId: string, workspaceId?: string) => Promise<void>;
}

export function MobileWorkspaceShell({
  mainTab,
  onSelectMainTab,
  activeView,
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
  usage,
  onRefreshWorkspaces,
  onSelectWorkspace,
  onSelectSurface,
  onBackToWorkspaces,
  onBackToSurfaces,
  onOpenPairModal,
  onSwitchHost,
  onRemoveHost,
  onRenameHost,
  onCreateSurface,
  onRenameSurface,
  onCloseSurface,
}: MobileWorkspaceShellProps) {
  return (
    <div className="flex-1 min-w-0 h-full overflow-hidden flex flex-col">
      <div className="flex-1 min-h-0 overflow-hidden">
        {mainTab === "workspaces" && (
          <>
            {activeView === "workspaces" && (
              <WorkspaceListView
                workspaces={workspaces}
                loading={loading}
                syncing={syncing}
                onRefresh={onRefreshWorkspaces}
                onSelectWorkspace={onSelectWorkspace}
                hostsCount={hosts.length}
                connState={connState}
                onPairHost={onOpenPairModal}
              />
            )}

            {activeView === "surfaces" && selectedWorkspace && (
              <SurfaceListView
                workspace={selectedWorkspace}
                onBack={onBackToWorkspaces}
                onSelectSurface={onSelectSurface}
                onCreateSurface={onCreateSurface}
                onRenameSurface={onRenameSurface}
                onCloseSurface={(id) => onCloseSurface(id, selectedWorkspace.id)}
                onRefresh={onRefreshWorkspaces}
              />
            )}

            {activeView === "detail" && selectedWorkspace && selectedSurface && (
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
              />
            )}
          </>
        )}

        {mainTab === "usage" && (
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
        )}

        {mainTab === "devices" && (
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
        )}
      </div>

      {(mainTab !== "workspaces" || activeView === "workspaces") && (
        <PrimaryTabNav mainTab={mainTab} onSelectTab={onSelectMainTab} unreadCount={totalUnread} />
      )}
    </div>
  );
}
