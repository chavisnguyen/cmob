import { useEffect, useState } from "react";
import { Loader2, Plus, Terminal, X } from "lucide-react";
import { RPC_METHODS } from "../../protocol/rpc";
import { wsClient } from "../../transport/wsClient";
import {
  effortAfterModelChange,
  effortsFor,
  hasAgentOptions,
  launchChoice,
  type AgentOptionsInfo,
  type LaunchChoice,
} from "../chat/agentOptions";
import { AgentIcon } from "../common/AgentIcon";
import { Pressable } from "../common/Pressable";

export interface CreateSurfaceParams {
  workspaceId: string;
  command?: string;
  launch?: LaunchChoice;
}

interface NewSurfaceModalProps {
  isOpen: boolean;
  workspaceId: string;
  workspaceTitle: string;
  onClose: () => void;
  onCreate: (params: CreateSurfaceParams) => Promise<void>;
}

interface AgentPreset {
  id: string;
  name: string;
  desc: string;
  command: string;
  agentKind?: string;
}

const PRESETS: AgentPreset[] = [
  {
    id: "shell",
    name: "Terminal Shell",
    desc: "Default login shell (zsh)",
    command: "",
  },
  {
    id: "claude",
    name: "Claude Code",
    desc: "claude",
    command: "claude",
    agentKind: "claude",
  },
  {
    id: "agy",
    name: "Antigravity",
    desc: "agy",
    command: "agy",
    agentKind: "antigravity",
  },
  {
    id: "codex",
    name: "Codex",
    desc: "codex",
    command: "codex",
    agentKind: "codex",
  },
  {
    id: "opencode",
    name: "OpenCode",
    desc: "opencode",
    command: "opencode",
    agentKind: "opencode",
  },
  {
    id: "kiro",
    name: "Kiro",
    desc: "kiro-cli",
    command: "kiro-cli",
    agentKind: "kiro",
  },
];

export function NewSurfaceModal({
  isOpen,
  workspaceId,
  workspaceTitle,
  onClose,
  onCreate,
}: NewSurfaceModalProps) {
  const [selectedPreset, setSelectedPreset] = useState<string>("shell");
  const [customCommand, setCustomCommand] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [optionsInfo, setOptionsInfo] = useState<AgentOptionsInfo | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);

  const presetKind = PRESETS.find((p) => p.id === selectedPreset)?.agentKind;
  const optionKind = presetKind && hasAgentOptions(presetKind) ? presetKind : null;

  useEffect(() => {
    setOptionsInfo(null);
    setModel(null);
    setEffort(null);
    if (!isOpen || !optionKind) return;
    let cancelled = false;
    wsClient
      .call<AgentOptionsInfo>(RPC_METHODS.AGENT_OPTIONS, { agent_kind: optionKind })
      .then((r) => !cancelled && setOptionsInfo(r))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isOpen, optionKind]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, loading, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    let commandToRun: string | undefined;
    if (selectedPreset === "custom") {
      commandToRun = customCommand.trim() || undefined;
    } else {
      const preset = PRESETS.find((item) => item.id === selectedPreset);
      commandToRun = preset?.command ? preset.command : undefined;
    }

    try {
      await onCreate({
        workspaceId,
        command: commandToRun,
        launch: optionKind ? launchChoice(optionKind, model, effort) : undefined,
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create tab");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/65 backdrop-blur-[1px] animate-fade-in"
      onClick={() => {
        if (!loading) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New Tab"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl bg-surface border border-line-strong text-fg shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-line bg-sidebar shrink-0">
          <div className="min-w-0">
            <h2 className="text-[13.5px] font-semibold text-fg">New Tab</h2>
            <p className="text-[11px] text-dim truncate">{workspaceTitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="w-7 h-7 rounded-md text-muted hover:text-fg hover:bg-raised flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="p-3.5 space-y-3 overflow-y-auto scrollbar-sleek bg-bg"
        >
          {error && (
            <div className="px-2.5 py-1.5 rounded-md bg-status-err/10 border border-status-err/30 text-status-err text-[12px]">
              {error}
            </div>
          )}

          <div className="space-y-1">
            {PRESETS.map((preset) => {
              const isSelected = selectedPreset === preset.id;
              return (
                <Pressable
                  key={preset.id}
                  onPress={() => setSelectedPreset(preset.id)}
                  className={`flex items-center justify-between px-2.5 py-2 rounded-lg border cursor-pointer transition-colors ${
                    isSelected
                      ? "bg-raised border-line-strong text-fg"
                      : "bg-sidebar border-line text-fg-soft hover:bg-surface"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-5 h-5 flex items-center justify-center shrink-0">
                      {preset.agentKind ? (
                        <AgentIcon kind={preset.agentKind} size={15} />
                      ) : (
                        <Terminal className="w-3.5 h-3.5 text-muted" />
                      )}
                    </div>
                    <div className="min-w-0 flex items-baseline gap-2">
                      <span className="text-[13px] font-medium truncate">{preset.name}</span>
                      <span className="text-[11px] font-mono text-dim truncate">{preset.desc}</span>
                    </div>
                  </div>
                  <div
                    className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 ${
                      isSelected ? "border-accent bg-accent" : "border-line-strong"
                    }`}
                  >
                    {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-bg" />}
                  </div>
                </Pressable>
              );
            })}

            {optionKind && optionsInfo && (
              <div className="rounded-lg border border-line bg-sidebar p-2.5 space-y-2">
                <label className="text-[11px] font-semibold text-muted uppercase tracking-wider">
                  Model (optional)
                </label>
                <select
                  value={model ?? ""}
                  onChange={(e) => {
                    const next = e.target.value || null;
                    setModel(next);
                    setEffort((cur) =>
                      next ? effortAfterModelChange(optionsInfo, next, cur) : cur,
                    );
                  }}
                  className="w-full h-8 rounded-md bg-bg border border-line-strong px-2 text-[13px] text-fg"
                >
                  <option value="">Default</option>
                  {optionsInfo.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                {(model ? effortsFor(optionsInfo, model) : []).length > 0 && (
                  <>
                    <label className="text-[11px] font-semibold text-muted uppercase tracking-wider">
                      Effort (optional)
                    </label>
                    <select
                      value={effort ?? ""}
                      onChange={(e) => setEffort(e.target.value || null)}
                      className="w-full h-8 rounded-md bg-bg border border-line-strong px-2 text-[13px] text-fg"
                    >
                      <option value="">Default</option>
                      {effortsFor(optionsInfo, model).map((e) => (
                        <option key={e.value} value={e.value}>
                          {e.label}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            )}

            <Pressable
              onPress={() => setSelectedPreset("custom")}
              className={`px-2.5 py-2 rounded-lg border cursor-pointer transition-colors ${
                selectedPreset === "custom"
                  ? "bg-raised border-line-strong text-fg"
                  : "bg-sidebar border-line text-fg-soft hover:bg-surface"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium">Custom Command</span>
                <div
                  className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                    selectedPreset === "custom" ? "border-accent bg-accent" : "border-line-strong"
                  }`}
                >
                  {selectedPreset === "custom" && (
                    <div className="w-1.5 h-1.5 rounded-full bg-bg" />
                  )}
                </div>
              </div>
              {selectedPreset === "custom" && (
                <input
                  type="text"
                  value={customCommand}
                  onChange={(event) => setCustomCommand(event.target.value)}
                  placeholder="e.g. htop, python3 main.py"
                  autoFocus
                  className="w-full mt-2 bg-bg border border-line-strong focus:border-accent/60 rounded-md px-2.5 py-1.5 text-[12px] font-mono text-fg placeholder-dim outline-none"
                />
              )}
            </Pressable>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 h-9 rounded-lg bg-raised hover:bg-line-strong text-[13px] font-medium text-fg-soft transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 h-9 rounded-lg bg-accent hover:bg-accent-strong disabled:opacity-50 text-[13px] font-medium text-bg flex items-center justify-center gap-1.5 transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Creating…</span>
                </>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create Tab</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
