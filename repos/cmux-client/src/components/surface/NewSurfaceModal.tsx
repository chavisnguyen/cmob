import { useEffect, useState } from "react";
import { Plus, Terminal, Bot, Sparkles, Cpu, X, Loader2 } from "lucide-react";
import { Pressable } from "../common/Pressable";
import { AgentIcon } from "../common/AgentIcon";
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

export interface CreateSurfaceParams {
  workspaceId: string;
  command?: string;
  /** Model / effort to launch the agent with (gateway appends the matching CLI flags). */
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
  icon: typeof Terminal;
  badge?: string;
  /** Gateway `agent_kind`; renders the brand logo instead of `icon`. */
  agentKind?: string;
}

const PRESETS: AgentPreset[] = [
  {
    id: "shell",
    name: "Terminal Shell",
    desc: "Default login shell (zsh/bash)",
    command: "",
    icon: Terminal,
  },
  {
    id: "claude",
    name: "Claude Code",
    desc: "Anthropic Claude coding agent",
    command: "claude",
    icon: Sparkles,
    agentKind: "claude",
    badge: "AI",
  },
  {
    id: "agy",
    name: "Antigravity (AGY)",
    desc: "DeepMind autonomous engineering agent",
    command: "agy",
    icon: Bot,
    agentKind: "antigravity",
    badge: "AI",
  },
  {
    id: "codex",
    name: "Codex",
    desc: "OpenAI terminal coding agent",
    command: "codex",
    icon: Cpu,
    agentKind: "codex",
    badge: "AI",
  },
  {
    id: "kiro",
    name: "Kiro",
    desc: "AWS Kiro CLI coding agent",
    command: "kiro-cli",
    icon: Bot,
    agentKind: "kiro",
    badge: "AI",
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
  // Optional launch choices for agents that have an option catalog (Claude, Codex).
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
      .catch(() => undefined); // no options: the section just does not appear
    return () => {
      cancelled = true;
    };
  }, [isOpen, optionKind]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-sm rounded-2xl bg-bg border border-white/[0.1] text-white shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.08] bg-bg">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-accent/15 text-accent-soft flex items-center justify-center">
              <Plus className="w-3.5 h-3.5" />
            </div>
            <div>
              <h2 className="text-[16px] font-semibold text-fg">New Tab</h2>
              <p className="text-[12px] text-muted truncate max-w-[180px]">{workspaceTitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="p-1 rounded-md text-muted hover:text-white hover:bg-raised transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="p-2 rounded bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[12px] font-semibold text-muted uppercase tracking-wider">
              Initial Program / Agent
            </label>
            <div className="space-y-1.5">
              {PRESETS.map((preset) => {
                const Icon = preset.icon;
                const isSelected = selectedPreset === preset.id;
                return (
                  <Pressable
                    key={preset.id}
                    onPress={() => setSelectedPreset(preset.id)}
                    className={`flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-accent/15 border-accent text-white"
                        : "bg-surface border-white/[0.08] text-fg-soft hover:bg-surface"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div
                        className={`w-6 h-6 rounded flex items-center justify-center shrink-0 ${
                          preset.agentKind
                            ? "bg-bg text-white border border-white/[0.08]"
                            : isSelected
                              ? "bg-accent text-white"
                              : "bg-raised text-muted"
                        }`}
                      >
                        {preset.agentKind ? (
                          <AgentIcon kind={preset.agentKind} size={16} />
                        ) : (
                          <Icon className="w-3.5 h-3.5" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[14px] font-medium truncate flex items-center gap-1.5">
                          <span>{preset.name}</span>
                          {preset.badge && (
                            <span className="px-1 py-0.2 rounded text-[9px] bg-accent/20 text-accent-soft font-semibold">
                              {preset.badge}
                            </span>
                          )}
                        </div>
                        <p className="text-[12px] text-muted truncate">{preset.desc}</p>
                      </div>
                    </div>
                    <div
                      className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                        isSelected ? "border-accent bg-accent" : "border-gray-600"
                      }`}
                    >
                      {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                    </div>
                  </Pressable>
                );
              })}

              {optionKind && optionsInfo && (
                <div className="rounded-lg border border-white/[0.08] bg-surface p-2.5 space-y-2">
                  <label className="text-[12px] font-semibold text-muted uppercase tracking-wider">
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
                    className="w-full h-10 rounded-lg bg-bg border border-white/[0.14] px-2.5 text-[14px] text-fg"
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
                      <label className="text-[12px] font-semibold text-muted uppercase tracking-wider">
                        Effort (optional)
                      </label>
                      <select
                        value={effort ?? ""}
                        onChange={(e) => setEffort(e.target.value || null)}
                        className="w-full h-10 rounded-lg bg-bg border border-white/[0.14] px-2.5 text-[14px] text-fg"
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
                className={`p-2.5 rounded-lg border cursor-pointer transition-colors ${
                  selectedPreset === "custom"
                    ? "bg-accent/15 border-accent text-white"
                    : "bg-surface border-white/[0.08] text-fg-soft hover:bg-surface"
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[14px] font-medium">Custom Command</span>
                  <div
                    className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                      selectedPreset === "custom" ? "border-accent bg-accent" : "border-gray-600"
                    }`}
                  >
                    {selectedPreset === "custom" && (
                      <div className="w-1.5 h-1.5 rounded-full bg-white" />
                    )}
                  </div>
                </div>
                {selectedPreset === "custom" && (
                  <input
                    type="text"
                    value={customCommand}
                    onChange={(event) => setCustomCommand(event.target.value)}
                    placeholder="e.g. htop, python3 main.py, bash"
                    autoFocus
                    className="w-full mt-1 bg-bg border border-white/[0.1] focus:border-accent rounded px-2.5 py-1.5 text-xs font-mono text-white placeholder-gray-600 outline-none"
                  />
                )}
              </Pressable>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 h-11 rounded-xl bg-raised hover:bg-line text-[14px] font-medium text-fg-soft transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 h-11 rounded-xl bg-accent hover:bg-accent-strong disabled:opacity-50 text-[14px] font-medium text-white flex items-center justify-center gap-1.5 shadow-sm transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Creating…</span>
                </>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Tab</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
