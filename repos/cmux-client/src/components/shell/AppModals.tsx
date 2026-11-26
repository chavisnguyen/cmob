import { lazy, Suspense } from "react";
import type { MainTab } from "../../domain/workspaceTree";
import { surfaceIdentity } from "../../domain/workspaceTree";
import type { SavedHost } from "../../hosts/hostStore";
import type { PairingOffer } from "../../protocol/pairing";
import type { NotificationAlertPayload, SurfaceNode, WorkspaceNode } from "../../protocol/rpc";
import type { ConnectionState } from "../../transport/wsClient";
import { HostSwitchSheet } from "../hosts/HostSwitchSheet";
import { PairingConfirmModal } from "../hosts/PairingConfirmModal";
import { CloseSurfaceDialog } from "../surface/CloseSurfaceDialog";
import { NewSurfaceModal, type CreateSurfaceParams } from "../surface/NewSurfaceModal";
import { ToastOverlay } from "./ToastOverlay";
import { TokenModal } from "./TokenModal";

const LazyChangesPanel = lazy(() =>
  import("../git/ChangesPanel").then((m) => ({ default: m.ChangesPanel })),
);
const LazyPairHostModal = lazy(() =>
  import("../hosts/PairHostModal").then((m) => ({ default: m.PairHostModal })),
);

export interface AppModalsProps {
  hosts: SavedHost[];
  activeHostId: string;
  connState: ConnectionState;
  showHostSheet: boolean;
  showPairModal: boolean;
  pendingPairing: PairingOffer | null;
  showTokenModal: boolean;
  tokenInput: string;
  activeToasts: NotificationAlertPayload[];
  sidebarNewWs: WorkspaceNode | null;
  sidebarCloseTarget: { ws: WorkspaceNode; surface: SurfaceNode } | null;
  changesWs: WorkspaceNode | null;
  onSwitchHost: (host: SavedHost) => void;
  onOpenPairModal: () => void;
  onClosePairModal: () => void;
  onPaired: () => void;
  onManageDevices: (tab: MainTab) => void;
  onCloseHostSheet: () => void;
  onAcceptPairing: () => void;
  onRejectPairing: () => void;
  onSelectToast: (toast: NotificationAlertPayload) => void;
  onDismissToast: (notificationId: string) => void;
  onCloseNewSurface: () => void;
  onCreateSurface: (params: CreateSurfaceParams) => Promise<void>;
  onCloseSurfaceDialog: () => void;
  onConfirmCloseSurface: (surfaceId: string, workspaceId: string) => Promise<void>;
  onCloseChanges: () => void;
  onChangeToken: (value: string) => void;
  onSaveToken: () => void;
  onCloseTokenModal: () => void;
}

export function AppModals({
  hosts,
  activeHostId,
  connState,
  showHostSheet,
  showPairModal,
  pendingPairing,
  showTokenModal,
  tokenInput,
  activeToasts,
  sidebarNewWs,
  sidebarCloseTarget,
  changesWs,
  onSwitchHost,
  onOpenPairModal,
  onClosePairModal,
  onPaired,
  onManageDevices,
  onCloseHostSheet,
  onAcceptPairing,
  onRejectPairing,
  onSelectToast,
  onDismissToast,
  onCloseNewSurface,
  onCreateSurface,
  onCloseSurfaceDialog,
  onConfirmCloseSurface,
  onCloseChanges,
  onChangeToken,
  onSaveToken,
  onCloseTokenModal,
}: AppModalsProps) {
  return (
    <>
      {showHostSheet && (
        <HostSwitchSheet
          hosts={hosts}
          activeHostId={activeHostId}
          connState={connState}
          onSelect={onSwitchHost}
          onAdd={onOpenPairModal}
          onManage={() => onManageDevices("devices")}
          onClose={onCloseHostSheet}
        />
      )}

      <ToastOverlay
        toasts={activeToasts}
        onSelectToast={onSelectToast}
        onDismissToast={onDismissToast}
      />

      {showPairModal && (
        <Suspense fallback={null}>
          <LazyPairHostModal onClose={onClosePairModal} onPaired={onPaired} />
        </Suspense>
      )}

      {pendingPairing && (
        <PairingConfirmModal
          offer={pendingPairing}
          onAccept={onAcceptPairing}
          onReject={onRejectPairing}
        />
      )}

      {sidebarNewWs && (
        <NewSurfaceModal
          isOpen={Boolean(sidebarNewWs)}
          workspaceId={sidebarNewWs.id}
          workspaceTitle={sidebarNewWs.title}
          onClose={onCloseNewSurface}
          onCreate={onCreateSurface}
        />
      )}

      {sidebarCloseTarget && (
        <CloseSurfaceDialog
          isOpen={Boolean(sidebarCloseTarget)}
          surfaceTitle={sidebarCloseTarget.surface.title}
          onClose={onCloseSurfaceDialog}
          onConfirm={async () => {
            const id = surfaceIdentity(sidebarCloseTarget.surface);
            await onConfirmCloseSurface(id, sidebarCloseTarget.ws.id);
            onCloseSurfaceDialog();
          }}
        />
      )}

      {changesWs && (
        <Suspense fallback={null}>
          <LazyChangesPanel
            workspaceId={changesWs.id}
            workspaceTitle={changesWs.title}
            onClose={onCloseChanges}
          />
        </Suspense>
      )}

      {showTokenModal && (
        <TokenModal
          tokenInput={tokenInput}
          onChangeToken={onChangeToken}
          onSave={onSaveToken}
          onClose={onCloseTokenModal}
        />
      )}
    </>
  );
}
