import { useCallback, useEffect, useState } from "react";
import type { SavedHost } from "../hosts/hostStore";
import { useHosts } from "../hosts/useHosts";
import type { PairingOffer } from "../protocol/pairing";
import { wsClient, type ConnectionState } from "../transport/wsClient";

export interface UseHostSessionOptions {
  /** Resets workspace/selection/git-changes/toast state whenever the active host changes. */
  onResetForHostChange: (nextEndpoint?: string | null) => void;
  /** Triggered after switching/pairing when already connected (e.g. demo mode). */
  onConnectedHostReady: () => void;
}

export function useHostSession({
  onResetForHostChange,
  onConnectedHostReady,
}: UseHostSessionOptions) {
  const { hosts, activeHostId, activeHost, switchHost, removeHost, renameHost } = useHosts();
  const [connState, setConnState] = useState<ConnectionState>(() => wsClient.getState());
  const [tokenInput, setTokenInput] = useState(() => wsClient.getToken());
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [showPairModal, setShowPairModal] = useState(false);
  const [showHostSheet, setShowHostSheet] = useState(false);
  const [pendingPairing, setPendingPairing] = useState<PairingOffer | null>(() =>
    wsClient.getPendingPairing(),
  );

  useEffect(() => wsClient.onStateChange((state) => setConnState(state)), []);

  useEffect(
    () => wsClient.onPairingChange(() => setPendingPairing(wsClient.getPendingPairing())),
    [],
  );

  useEffect(() => {
    setTokenInput(wsClient.getToken());
  }, [activeHostId]);

  useEffect(() => {
    wsClient.connect();
    return () => {
      wsClient.disconnect();
    };
  }, []);

  const handleSwitchHost = useCallback(
    (host: SavedHost) => {
      onResetForHostChange(host.endpoint);
      switchHost(host);
      if (wsClient.getState() === "connected") {
        onConnectedHostReady();
      }
    },
    [onResetForHostChange, switchHost, onConnectedHostReady],
  );

  const handleRemoveHost = useCallback(
    (id: string) => {
      if (activeHostId === id) {
        const remaining = hosts.filter((h) => h.id !== id);
        onResetForHostChange(remaining[0]?.endpoint ?? null);
      }
      removeHost(id);
    },
    [activeHostId, hosts, onResetForHostChange, removeHost],
  );

  const handleAcceptPairing = useCallback(() => {
    const offer = wsClient.getPendingPairing();
    onResetForHostChange(offer?.endpoint ?? null);
    wsClient.acceptPendingPairing();
    if (wsClient.getState() === "connected") {
      onConnectedHostReady();
    }
  }, [onResetForHostChange, onConnectedHostReady]);

  const handleRejectPairing = useCallback(() => {
    wsClient.rejectPendingPairing();
  }, []);

  const handleSaveToken = useCallback(() => {
    wsClient.setToken(tokenInput.trim());
    setShowTokenModal(false);
  }, [tokenInput]);

  return {
    hosts,
    activeHostId,
    activeHost,
    connState,
    tokenInput,
    setTokenInput,
    showTokenModal,
    setShowTokenModal,
    showPairModal,
    setShowPairModal,
    showHostSheet,
    setShowHostSheet,
    pendingPairing,
    renameHost,
    handleSwitchHost,
    handleRemoveHost,
    handleAcceptPairing,
    handleRejectPairing,
    handleSaveToken,
  };
}
