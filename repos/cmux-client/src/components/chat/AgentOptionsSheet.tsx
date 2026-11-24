import { useEffect, useState } from "react";
import { Loader2, SlidersHorizontal, X } from "lucide-react";
import { RPC_METHODS } from "../../protocol/rpc";
import { wsClient } from "../../transport/wsClient";
import { effortAfterModelChange, effortsFor, type AgentOptionsInfo } from "./agentOptions";

/**
 * Change model / effort of a running agent. Claude: the gateway types `/model <id>`, `/effort <level>` or
 * `/fast` into the TUI. Codex: the gateway types `/model` and Codex opens its own picker, which has to be
 * answered in the Terminal tab (Orca: agent-session-option-catalog-claude-codex.ts, midSession).
 */
export function AgentOptionsSheet({
  surfaceId,
  agentKind,
  currentModel,
  onClose,
  onOpenTerminal,
}: {
  surfaceId: string;
  agentKind: string;
  /** Model id reported by the transcript (e.g. "claude-sonnet-5-5"), used only to hint the selection. */
  currentModel?: string;
  onClose: () => void;
  onOpenTerminal?: () => void;
}) {
  const [info, setInfo] = useState<AgentOptionsInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Not readable back from a TUI: what this phone last set in this sheet.
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const [chosenEffort, setChosenEffort] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    wsClient
      .call<AgentOptionsInfo>(RPC_METHODS.AGENT_OPTIONS, { agent_kind: agentKind })
      .then((r) => !cancelled && setInfo(r))
      .catch(
        (e) =>
          !cancelled && setLoadError(e instanceof Error ? e.message : "Could not load options."),
      );
    return () => {
      cancelled = true;
    };
  }, [agentKind]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const apply = async (option: "model" | "effort" | "fast", value?: string) => {
    setBusy(`${option}:${value ?? ""}`);
    setError(null);
    setNote(null);
    try {
      const r = await wsClient.call<{ status: string }>(
        RPC_METHODS.CHAT_SET_OPTION,
        { surface_id: surfaceId, agent_kind: agentKind, option, value },
        { timeoutMs: 30_000 },
      );
      if (r.status === "picker_opened") {
        onClose();
        onOpenTerminal?.();
        return;
      }
      if (option === "model" && value && info) {
        setChosenModel(value);
        setChosenEffort(effortAfterModelChange(info, value, chosenEffort));
      }
      if (option === "effort" && value) setChosenEffort(value);
      setNote("Sent to the agent.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the option.");
    } finally {
      setBusy(null);
    }
  };

  const selectedModel =
    chosenModel ?? info?.models.find((m) => currentModel?.includes(m.id))?.id ?? null;
  const efforts = info ? effortsFor(info, selectedModel) : [];
  const fastModel = info?.models.find((m) => m.id === selectedModel && m.fast);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center md:p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Model and effort"
        className="w-full max-w-md max-h-[85dvh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-bg border-t md:border border-white/[0.12] text-fg p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] md:pb-5 space-y-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-semibold flex items-center gap-2">
            <SlidersHorizontal className="w-5 h-5 text-accent-soft" />
            Model &amp; effort
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-white/[0.08] flex items-center justify-center"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {!info && !loadError && <Loader2 className="w-5 h-5 animate-spin text-accent-soft" />}
        {loadError && <p className="text-[13px] text-amber-300">{loadError}</p>}

        {info?.mid_session === "picker" && (
          <div className="space-y-3">
            <p className="text-[13.5px] text-fg-soft leading-relaxed">
              {agentKind === "codex" ? "Codex" : "This agent"} chooses its model and reasoning
              effort in its own picker. It opens in the Terminal tab; pick there.
            </p>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void apply("model")}
              className="w-full h-11 rounded-xl bg-accent disabled:opacity-50 text-[14px] font-semibold text-white"
            >
              {busy ? "Opening…" : "Open model picker"}
            </button>
          </div>
        )}

        {info?.mid_session === "command" && (
          <>
            <section className="space-y-2">
              <h3 className="text-[13px] font-semibold text-fg-soft">Model</h3>
              {info.models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void apply("model", m.id)}
                  className={`w-full text-left rounded-xl border px-3.5 py-2.5 disabled:opacity-50 ${
                    selectedModel === m.id
                      ? "border-accent bg-accent/10"
                      : "border-white/[0.1] bg-bg"
                  }`}
                >
                  <div className="text-[14px] font-semibold">{m.label}</div>
                  {m.description && <div className="text-[12px] text-muted">{m.description}</div>}
                </button>
              ))}
            </section>

            {efforts.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-[13px] font-semibold text-fg-soft">Effort</h3>
                <div className="flex flex-wrap gap-2">
                  {efforts.map((e) => (
                    <button
                      key={e.value}
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void apply("effort", e.value)}
                      className={`h-9 px-3.5 rounded-lg text-[13px] font-semibold disabled:opacity-50 ${
                        chosenEffort === e.value ? "bg-accent text-white" : "bg-raised text-fg-soft"
                      }`}
                    >
                      {e.label}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {fastModel && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void apply("fast")}
                className="w-full h-10 rounded-xl bg-raised disabled:opacity-50 text-[13.5px] font-semibold"
              >
                Toggle fast mode
              </button>
            )}

            <p className="text-[12px] leading-relaxed text-muted">
              Claude saves this as your default for new sessions too (it says so in the terminal),
              so it also changes what you get the next time you start Claude on this Mac.
            </p>
          </>
        )}

        {error && <p className="text-[13px] text-rose-400">{error}</p>}
        {note && !error && <p className="text-[13px] text-emerald-400">{note}</p>}
      </div>
    </div>
  );
}
