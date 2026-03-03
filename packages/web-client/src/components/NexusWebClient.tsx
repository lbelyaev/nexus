"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useApproval,
  useConnection,
  useSession,
  type MemoryResultEvent,
  type UseApprovalResult,
  type UseSessionResult,
} from "@nexus/client-core";
import type { GatewayEvent } from "@nexus/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { inferRuntimeFromModel, resolveModelAlias } from "../lib/modelRouting";

type ChatRole = "user" | "assistant" | "system";

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
}

interface ConnectedClientProps {
  url: string;
  token: string;
  initialRuntimeId?: string;
  initialModel?: string;
  initialWorkspaceId: string;
  onDisconnect: () => void;
}

const makeId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const compact = (text: string, max: number = 120): string => {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 3)}...`;
};

const formatMemoryResult = (event: MemoryResultEvent): ChatMessage[] => {
  const scopeLabel = `scope=${event.scope}`;

  switch (event.action) {
    case "stats":
      return [
        {
          id: makeId(),
          role: "system",
          text: `Memory stats (${scopeLabel}): facts=${event.stats.facts}, summaries=${event.stats.summaries}, total=${event.stats.total}, memoryTokens=${event.stats.memoryTokens}, transcriptMessages=${event.stats.transcriptMessages}, transcriptTokens=${event.stats.transcriptTokens}`,
        },
      ];
    case "recent":
      if (event.items.length === 0) {
        return [{ id: makeId(), role: "system", text: `No recent memory items (${scopeLabel}).` }];
      }
      return [
        {
          id: makeId(),
          role: "system",
          text: `Recent memory (${event.items.length}/${event.limit}, ${scopeLabel}):`,
        },
        ...event.items.map((item) => ({
          id: makeId(),
          role: "system" as const,
          text: `- [${item.kind}] c=${item.confidence.toFixed(2)} ${compact(item.content)}`,
        })),
      ];
    case "search":
      if (event.items.length === 0) {
        return [{ id: makeId(), role: "system", text: `No memory matches for \"${event.query}\" (${scopeLabel}).` }];
      }
      return [
        {
          id: makeId(),
          role: "system",
          text: `Memory search \"${event.query}\" (${event.items.length}/${event.limit}, ${scopeLabel}):`,
        },
        ...event.items.map((item) => ({
          id: makeId(),
          role: "system" as const,
          text: `- [${item.kind}] c=${item.confidence.toFixed(2)} ${compact(item.content)}`,
        })),
      ];
    case "context":
      return [
        {
          id: makeId(),
          role: "system",
          text: `Memory context (${scopeLabel}): tokens=${event.context.totalTokens}/${event.context.budgetTokens}, hot=${event.context.hot.length}, warm=${event.context.warm.length}, cold=${event.context.cold.length}`,
        },
      ];
    case "clear":
      return [
        {
          id: makeId(),
          role: "system",
          text: `Cleared ${event.deleted} memory item(s) (${scopeLabel}).`,
        },
      ];
  }
};

const MarkdownView = ({ text }: { text: string }) => (
  <div className="markdown-body">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => (
          <a className="text-pulse-400 underline underline-offset-2" target="_blank" rel="noreferrer" {...props}>
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  </div>
);

const ConnectedClient = ({
  url,
  token,
  initialRuntimeId,
  initialModel,
  initialWorkspaceId,
  onDisconnect,
}: ConnectedClientProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [promptInput, setPromptInput] = useState("");
  const [preferredRuntimeId, setPreferredRuntimeId] = useState<string | undefined>(initialRuntimeId);
  const [preferredModel, setPreferredModel] = useState<string | undefined>(initialModel);
  const [preferredWorkspaceId, setPreferredWorkspaceId] = useState(initialWorkspaceId);
  const [localAliases, setLocalAliases] = useState<Record<string, string>>({});
  const [aliasName, setAliasName] = useState("");
  const [aliasTarget, setAliasTarget] = useState("");
  const [memorySearch, setMemorySearch] = useState("");

  const creatingSessionRef = useRef(false);
  const prevStreamingRef = useRef(false);
  const processedMemoryResultsRef = useRef(0);
  const previousStatusRef = useRef<"connecting" | "connected" | "disconnected" | "error">("connecting");

  const sessionRef = useRef<UseSessionResult | null>(null);
  const approvalRef = useRef<UseApprovalResult | null>(null);

  const appendSystem = useCallback((text: string): void => {
    setMessages((prev) => [...prev, { id: makeId(), role: "system", text }]);
  }, []);

  const handleEvent = useCallback((event: GatewayEvent) => {
    sessionRef.current?.handleEvent(event);
    approvalRef.current?.handleEvent(event);
  }, []);

  const { status, sendMessage, disconnect } = useConnection({ url, token, onEvent: handleEvent });
  const session = useSession(sendMessage);
  const approval = useApproval(sendMessage);

  sessionRef.current = session;
  approvalRef.current = approval;

  const createSession = useCallback(
    (runtimeId?: string, model?: string, workspaceId?: string) => {
      sendMessage({
        type: "session_new",
        runtimeId,
        model,
        workspaceId: workspaceId ?? preferredWorkspaceId,
      });
    },
    [preferredWorkspaceId, sendMessage],
  );

  useEffect(() => {
    if (previousStatusRef.current !== status) {
      appendSystem(`Connection ${status}`);
      previousStatusRef.current = status;
    }
  }, [appendSystem, status]);

  useEffect(() => {
    if (status !== "connected") {
      creatingSessionRef.current = false;
      return;
    }
    if (session.sessionId) {
      creatingSessionRef.current = false;
      return;
    }
    if (creatingSessionRef.current) return;

    creatingSessionRef.current = true;
    createSession(preferredRuntimeId, preferredModel, preferredWorkspaceId);
  }, [createSession, preferredModel, preferredRuntimeId, preferredWorkspaceId, session.sessionId, status]);

  useEffect(() => {
    if (prevStreamingRef.current && !session.isStreaming) {
      setMessages((prev) => {
        const next: ChatMessage[] = [];
        for (const tool of session.toolCalls) {
          const icon = tool.status === "completed" ? "+" : tool.status === "failed" ? "x" : "~";
          next.push({ id: makeId(), role: "system", text: `${icon} ${tool.tool}` });
        }
        if (session.responseText.trim()) {
          next.push({ id: makeId(), role: "assistant", text: session.responseText });
        }
        return next.length > 0 ? [...prev, ...next] : prev;
      });
    }
    prevStreamingRef.current = session.isStreaming;
  }, [session.isStreaming, session.responseText, session.toolCalls]);

  useEffect(() => {
    if (session.memoryResults.length <= processedMemoryResultsRef.current) return;
    const freshEvents = session.memoryResults.slice(processedMemoryResultsRef.current);
    processedMemoryResultsRef.current = session.memoryResults.length;
    const rendered = freshEvents.flatMap((event) => formatMemoryResult(event));
    setMessages((prev) => [...prev, ...rendered]);
  }, [session.memoryResults]);

  const runtimeIds = useMemo(() => Object.keys(session.modelCatalog).sort(), [session.modelCatalog]);
  const activeRuntimeForCatalog = preferredRuntimeId ?? session.sessionRuntimeId ?? runtimeIds[0];
  const modelCatalogForRuntime = activeRuntimeForCatalog
    ? session.modelCatalog[activeRuntimeForCatalog] ?? []
    : [];

  const handleApplyRuntimeModel = useCallback(() => {
    if (session.isStreaming) {
      appendSystem("Cannot switch runtime/model while streaming. Cancel current turn first.");
      return;
    }

    const resolved = resolveModelAlias(preferredModel ?? "", localAliases, session.modelAliases);
    const inferredRuntime = resolved.resolved
      ? inferRuntimeFromModel(resolved.resolved, session.modelRouting)
      : undefined;
    const effectiveRuntime = preferredRuntimeId ?? inferredRuntime;
    const effectiveModel = resolved.resolved || undefined;

    if (inferredRuntime && inferredRuntime !== preferredRuntimeId) {
      setPreferredRuntimeId(inferredRuntime);
    }

    createSession(effectiveRuntime, effectiveModel, preferredWorkspaceId);
    appendSystem(
      `Starting session: workspace=${preferredWorkspaceId}, runtime=${effectiveRuntime ?? "default"}, model=${effectiveModel ?? "default"}`,
    );
  }, [
    appendSystem,
    createSession,
    localAliases,
    preferredModel,
    preferredRuntimeId,
    preferredWorkspaceId,
    session.isStreaming,
    session.modelAliases,
    session.modelRouting,
  ]);

  const handleRecoverStream = useCallback(() => {
    if (!session.sessionId) {
      appendSystem("No active session to recover.");
      return;
    }
    const fallbackRuntime = preferredRuntimeId ?? session.sessionRuntimeId ?? undefined;
    const fallbackModel = preferredModel ?? session.sessionModel ?? undefined;
    createSession(fallbackRuntime, fallbackModel, preferredWorkspaceId);
    appendSystem("Recovery: started a fresh session to clear stuck streaming state.");
  }, [
    appendSystem,
    createSession,
    preferredModel,
    preferredRuntimeId,
    preferredWorkspaceId,
    session.sessionId,
    session.sessionModel,
    session.sessionRuntimeId,
  ]);

  const handleSendPrompt = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const text = promptInput.trim();
      if (!text) return;
      if (!session.sessionId) {
        appendSystem("No active session yet.");
        return;
      }

      if (text.startsWith("/")) {
        setMessages((prev) => [...prev, { id: makeId(), role: "user", text }]);
        const [command, ...restParts] = text.slice(1).trim().split(/\s+/);
        const arg = restParts.join(" ").trim();
        const normalized = command?.toLowerCase() ?? "";

        if (normalized === "status") {
          appendSystem(`connection=${status}`);
          appendSystem(`session=${session.sessionId ?? "(none)"}`);
          appendSystem(`workspace=${session.sessionWorkspaceId ?? preferredWorkspaceId}`);
          appendSystem(`runtime=${session.sessionRuntimeId ?? preferredRuntimeId ?? "default"}`);
          appendSystem(`model=${session.sessionModel ?? preferredModel ?? "default"}`);
          appendSystem(`streaming=${session.isStreaming ? "yes" : "no"}, approvals=${approval.pendingApprovals.length}, activeTools=${session.activeTools.length}`);
          setPromptInput("");
          return;
        }

        if (normalized === "models") {
          const runtimes = Object.keys(session.modelCatalog).sort();
          if (runtimes.length === 0) {
            appendSystem("No model catalog reported by gateway.");
          } else {
            appendSystem("Available models:");
            for (const runtimeId of runtimes) {
              const defaultModel = session.runtimeDefaults[runtimeId] ?? "(none)";
              appendSystem(`[${runtimeId}] default=${defaultModel}`);
              for (const modelId of session.modelCatalog[runtimeId] ?? []) {
                appendSystem(`  - ${modelId}`);
              }
            }
          }
          setPromptInput("");
          return;
        }

        if (normalized === "runtime") {
          if (!arg) {
            appendSystem(`Runtime: ${preferredRuntimeId ?? session.sessionRuntimeId ?? "default"}`);
            setPromptInput("");
            return;
          }
          if (session.isStreaming) {
            appendSystem("Cannot switch runtime while streaming. Cancel or recover first.");
            setPromptInput("");
            return;
          }
          setPreferredRuntimeId(arg);
          createSession(arg, preferredModel, preferredWorkspaceId);
          appendSystem(`Runtime set to ${arg}. Started a new session.`);
          setPromptInput("");
          return;
        }

        if (normalized === "model") {
          if (!arg) {
            appendSystem(`Model: ${preferredModel ?? session.sessionModel ?? "default"}`);
            setPromptInput("");
            return;
          }
          if (session.isStreaming) {
            appendSystem("Cannot switch model while streaming. Cancel or recover first.");
            setPromptInput("");
            return;
          }
          const resolved = resolveModelAlias(arg, localAliases, session.modelAliases);
          const mappedRuntime = inferRuntimeFromModel(resolved.resolved, session.modelRouting);
          if (mappedRuntime) {
            setPreferredRuntimeId(mappedRuntime);
          }
          setPreferredModel(arg);
          createSession(mappedRuntime ?? preferredRuntimeId, resolved.resolved, preferredWorkspaceId);
          appendSystem(`Model set to ${arg}${mappedRuntime ? ` (runtime ${mappedRuntime})` : ""}. Started a new session.`);
          setPromptInput("");
          return;
        }

        if (normalized === "workspace") {
          if (!arg) {
            appendSystem(`Workspace: ${preferredWorkspaceId}`);
            setPromptInput("");
            return;
          }
          if (session.isStreaming) {
            appendSystem("Cannot switch workspace while streaming. Cancel or recover first.");
            setPromptInput("");
            return;
          }
          setPreferredWorkspaceId(arg);
          createSession(preferredRuntimeId, preferredModel, arg);
          appendSystem(`Workspace set to ${arg}. Started a new session.`);
          setPromptInput("");
          return;
        }

        if (normalized === "cancel") {
          if (session.isStreaming) {
            session.cancel();
            appendSystem("Cancelled current turn.");
          } else {
            appendSystem("No running turn to cancel.");
          }
          setPromptInput("");
          return;
        }

        if (normalized === "close") {
          if (!session.sessionId) {
            appendSystem("No active session to close.");
          } else {
            session.closeSession();
            appendSystem(`Closing session ${session.sessionId}...`);
          }
          setPromptInput("");
          return;
        }

        appendSystem("Unknown local command. Use /status, /models, /runtime, /model, /workspace, /cancel, /close.");
        setPromptInput("");
        return;
      }

      setMessages((prev) => [...prev, { id: makeId(), role: "user", text }]);
      if (session.isStreaming) {
        session.steer(text);
      } else {
        session.sendPrompt(text);
      }
      setPromptInput("");
    },
    [
      appendSystem,
      approval.pendingApprovals.length,
      createSession,
      localAliases,
      preferredModel,
      preferredRuntimeId,
      preferredWorkspaceId,
      promptInput,
      session,
      status,
    ],
  );

  const handleCancel = useCallback(() => {
    if (!session.isStreaming) return;
    session.cancel();
    appendSystem("Cancelled current turn.");
  }, [appendSystem, session]);

  const handleCloseSession = useCallback(() => {
    if (!session.sessionId) {
      appendSystem("No active session to close.");
      return;
    }
    session.closeSession();
    appendSystem(`Closing session ${session.sessionId}...`);
  }, [appendSystem, session]);

  const handleAddAlias = useCallback(() => {
    const alias = aliasName.trim().toLowerCase();
    const target = aliasTarget.trim();
    if (!alias || !target) {
      appendSystem("Alias usage: nickname + model id.");
      return;
    }
    setLocalAliases((prev) => ({ ...prev, [alias]: target }));
    setAliasName("");
    setAliasTarget("");
    appendSystem(`Alias set: ${alias} -> ${target}`);
  }, [aliasName, aliasTarget, appendSystem]);

  const currentApproval = approval.pendingApprovals[0] ?? null;

  const handleApprove = useCallback(() => {
    if (!currentApproval) return;
    approval.approve(currentApproval.requestId);
    appendSystem(`Approved: ${currentApproval.tool}`);
  }, [appendSystem, approval, currentApproval]);

  const handleApproveAll = useCallback(() => {
    if (approval.pendingApprovals.length === 0) return;
    const names = approval.pendingApprovals.map((item) => item.tool).join(", ");
    approval.approveAll();
    appendSystem(`Approved all pending tools: ${names}`);
  }, [appendSystem, approval]);

  const handleDeny = useCallback(() => {
    if (!currentApproval) return;
    approval.deny(currentApproval.requestId);
    appendSystem(`Denied: ${currentApproval.tool}`);
  }, [appendSystem, approval, currentApproval]);

  const runtimeHealthLines = useMemo(
    () => Object.entries(session.runtimeHealth).sort(([a], [b]) => a.localeCompare(b)),
    [session.runtimeHealth],
  );

  return (
    <div className="grid h-[calc(100vh-2.5rem)] gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="panel p-4">
        <h2 className="panel-title">Session Control</h2>

        <div className="space-y-3">
          <label className="field">
            <span>Workspace</span>
            <input
              className="input"
              value={preferredWorkspaceId}
              onChange={(event) => setPreferredWorkspaceId(event.target.value)}
              placeholder="default"
            />
          </label>

          <label className="field">
            <span>Runtime</span>
            <select
              className="input"
              value={preferredRuntimeId ?? ""}
              onChange={(event) => setPreferredRuntimeId(event.target.value || undefined)}
            >
              <option value="">default</option>
              {runtimeIds.map((runtimeId) => (
                <option key={runtimeId} value={runtimeId}>{runtimeId}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Model</span>
            <input
              className="input"
              list="model-catalog"
              value={preferredModel ?? ""}
              onChange={(event) => setPreferredModel(event.target.value || undefined)}
              placeholder="Use runtime default"
            />
            <datalist id="model-catalog">
              {modelCatalogForRuntime.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>

          <button type="button" className="button-primary" onClick={handleApplyRuntimeModel}>
            Start New Session
          </button>
        </div>

        <div className="divider" />

        <h3 className="panel-subtitle">Aliases</h3>
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <input
            className="input"
            value={aliasName}
            onChange={(event) => setAliasName(event.target.value)}
            placeholder="nick"
          />
          <input
            className="input"
            value={aliasTarget}
            onChange={(event) => setAliasTarget(event.target.value)}
            placeholder="model-id"
          />
          <button type="button" className="button-secondary" onClick={handleAddAlias}>Add</button>
        </div>
        {Object.keys(localAliases).length > 0 ? (
          <div className="mt-2 text-xs text-ink-100/80">
            {Object.entries(localAliases).map(([alias, target]) => (
              <div key={alias}>{alias} {"->"} {target}</div>
            ))}
          </div>
        ) : null}

        <div className="divider" />

        <h3 className="panel-subtitle">Memory</h3>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="button-secondary"
            onClick={() => session.requestMemory({ action: "stats", scope: "session" })}
            disabled={!session.sessionId}
          >
            Stats Session
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={() => session.requestMemory({ action: "stats", scope: "workspace" })}
            disabled={!session.sessionId}
          >
            Stats Workspace
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={() => session.requestMemory({ action: "clear", scope: "session" })}
            disabled={!session.sessionId}
          >
            Clear Session
          </button>
        </div>
        <div className="mt-2 flex gap-2">
          <input
            className="input"
            value={memorySearch}
            onChange={(event) => setMemorySearch(event.target.value)}
            placeholder="search memory"
          />
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              const query = memorySearch.trim();
              if (!query) return;
              session.requestMemory({ action: "search", query, scope: "workspace" });
            }}
            disabled={!session.sessionId}
          >
            Search
          </button>
        </div>

        <div className="divider" />

        <h3 className="panel-subtitle">Status</h3>
        <div className="text-xs leading-6 text-ink-100/90">
          <div>connection: {status}</div>
          <div>session: {session.sessionId ?? "(none)"}</div>
          <div>workspace: {session.sessionWorkspaceId ?? preferredWorkspaceId}</div>
          <div>runtime: {session.sessionRuntimeId ?? preferredRuntimeId ?? "default"}</div>
          <div>model: {session.sessionModel ?? preferredModel ?? "default"}</div>
          <div>streaming: {session.isStreaming ? "yes" : "no"}</div>
          <div>pending approvals: {approval.pendingApprovals.length}</div>
          <div>active tools: {session.activeTools.length}</div>
          {runtimeHealthLines.map(([runtimeId, health]) => (
            <div key={runtimeId}>health.{runtimeId}: {health.status}{health.reason ? ` (${health.reason})` : ""}</div>
          ))}
        </div>

        <div className="mt-4 flex gap-2">
          <button type="button" className="button-secondary" onClick={handleCloseSession}>Close Session</button>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              disconnect();
              onDisconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      </aside>

      <section className="panel flex min-h-0 flex-col p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h1 className="panel-title">Nexus Web Client</h1>
            <p className="text-xs text-ink-100/75">Next.js + Tailwind pilot using @nexus/client-core</p>
          </div>
          <div className="chip">
            {session.sessionWorkspaceId ?? preferredWorkspaceId}/{session.sessionRuntimeId ?? preferredRuntimeId ?? "default"}:{session.sessionModel ?? preferredModel ?? "default"}
          </div>
        </div>

        <div className="mb-3 flex-1 space-y-3 overflow-y-auto pr-1">
          {messages.map((message) => (
            <article
              key={message.id}
              className={`message ${
                message.role === "user"
                  ? "message-user"
                  : message.role === "assistant"
                    ? "message-assistant"
                    : "message-system"
              }`}
            >
              <header className="message-role">{message.role}</header>
              {message.role === "assistant" ? (
                <MarkdownView text={message.text} />
              ) : (
                <p className="whitespace-pre-wrap text-sm leading-6">{message.text}</p>
              )}
            </article>
          ))}

          {session.isStreaming && (session.responseText || session.thinkingText) ? (
            <article className="message message-assistant message-streaming">
              <header className="message-role">assistant (streaming)</header>
              {session.thinkingText ? (
                <p className="mb-3 whitespace-pre-wrap text-xs italic text-ink-100/65">{session.thinkingText}</p>
              ) : null}
              <MarkdownView text={session.responseText || "..."} />
            </article>
          ) : null}
        </div>

        {session.activeTools.length > 0 ? (
          <div className="mb-3 rounded-lg border border-pulse-500/25 bg-ink-900/75 px-3 py-2 text-xs text-pulse-300">
            {session.activeTools.map((tool) => `~ ${tool.tool}`).join("  ")}
          </div>
        ) : null}

        {currentApproval ? (
          <div className="mb-3 rounded-lg border border-yellow-400/45 bg-yellow-500/10 p-3">
            <div className="text-sm font-semibold text-yellow-300">Approval Required ({approval.pendingApprovals.length} pending)</div>
            <div className="mt-1 text-sm text-yellow-50">Tool: {currentApproval.tool}</div>
            <pre className="mt-1 overflow-x-auto text-xs text-yellow-100/90">{currentApproval.description}</pre>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="button-warning" onClick={handleApprove}>Approve</button>
              <button type="button" className="button-warning" onClick={handleApproveAll}>Approve All</button>
              <button type="button" className="button-danger" onClick={handleDeny}>Reject</button>
              <button type="button" className="button-secondary" onClick={handleCancel} disabled={!session.isStreaming}>Cancel Turn</button>
            </div>
          </div>
        ) : null}

        <form onSubmit={handleSendPrompt} className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
          <input
            className="input"
            value={promptInput}
            onChange={(event) => setPromptInput(event.target.value)}
            placeholder={session.isStreaming ? "Steer the running turn..." : "Send a prompt..."}
            disabled={!session.sessionId}
          />
          <button type="submit" className="button-primary" disabled={!session.sessionId}>
            {session.isStreaming ? "Steer" : "Send"}
          </button>
          <button type="button" className="button-secondary" onClick={handleCancel} disabled={!session.isStreaming}>
            Cancel
          </button>
          <button type="button" className="button-secondary" onClick={handleRecoverStream}>
            Recover
          </button>
        </form>
      </section>
    </div>
  );
};

export const NexusWebClient = () => {
  const defaultUrl = process.env.NEXT_PUBLIC_NEXUS_URL?.trim() || "ws://127.0.0.1:18800/ws";
  const defaultToken = process.env.NEXT_PUBLIC_NEXUS_TOKEN?.trim() || "";
  const defaultWorkspace = process.env.NEXT_PUBLIC_NEXUS_WORKSPACE?.trim() || "default";
  const defaultRuntime = process.env.NEXT_PUBLIC_NEXUS_RUNTIME?.trim() || undefined;
  const defaultModel = process.env.NEXT_PUBLIC_NEXUS_MODEL?.trim() || undefined;

  const [urlInput, setUrlInput] = useState(defaultUrl);
  const [tokenInput, setTokenInput] = useState(defaultToken);
  const [connection, setConnection] = useState<{ url: string; token: string } | null>(
    defaultToken
      ? { url: defaultUrl, token: defaultToken }
      : null,
  );

  if (!connection) {
    return (
      <div className="mx-auto flex min-h-[calc(100vh-2.5rem)] w-full max-w-3xl items-center justify-center">
        <div className="panel w-full max-w-xl p-6">
          <h1 className="panel-title">Connect Nexus</h1>
          <p className="mt-1 text-sm text-ink-100/75">Web client for session/runtime/model testing.</p>

          <div className="mt-5 space-y-3">
            <label className="field">
              <span>Gateway URL</span>
              <input
                className="input"
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                placeholder="ws://127.0.0.1:18800/ws"
              />
            </label>
            <label className="field">
              <span>Token</span>
              <input
                className="input"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                placeholder="NEXUS_TOKEN"
              />
            </label>
          </div>

          <button
            type="button"
            className="button-primary mt-4 w-full"
            onClick={() => {
              if (!urlInput.trim() || !tokenInput.trim()) return;
              setConnection({ url: urlInput.trim(), token: tokenInput.trim() });
            }}
            disabled={!urlInput.trim() || !tokenInput.trim()}
          >
            Connect
          </button>
        </div>
      </div>
    );
  }

  return (
    <ConnectedClient
      key={`${connection.url}|${connection.token}`}
      url={connection.url}
      token={connection.token}
      initialRuntimeId={defaultRuntime}
      initialModel={defaultModel}
      initialWorkspaceId={defaultWorkspace}
      onDisconnect={() => setConnection(null)}
    />
  );
};
