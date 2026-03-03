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
import { mergeContiguousMessages, type ChatMessage } from "../lib/chatMerge";
import { inferRuntimeFromModel, resolveModelAlias } from "../lib/modelRouting";
import { ScrollArea } from "./ui/ScrollArea";
import { Separator } from "./ui/Separator";

interface ConnectedClientProps {
  url: string;
  token: string;
  initialRuntimeId?: string;
  initialModel?: string;
  initialWorkspaceId: string;
  onDisconnect: () => void;
}

const makeId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const isDefined = <T,>(value: T | null | undefined): value is T => value !== null && value !== undefined;
const normalizeSelection = (value?: string | null): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") return undefined;
  return trimmed;
};

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

const WaitingFirstToken = () => (
  <div className="waiting-token" aria-live="polite" aria-label="Waiting for first token">
    <span className="waiting-dots" aria-hidden>
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
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
  const [preferredRuntimeId, setPreferredRuntimeId] = useState<string | undefined>(normalizeSelection(initialRuntimeId));
  const [preferredModel, setPreferredModel] = useState<string | undefined>(normalizeSelection(initialModel));
  const [preferredWorkspaceId, setPreferredWorkspaceId] = useState(initialWorkspaceId);
  const [localAliases, setLocalAliases] = useState<Record<string, string>>({});
  const [aliasName, setAliasName] = useState("");
  const [aliasTarget, setAliasTarget] = useState("");
  const [memorySearch, setMemorySearch] = useState("");
  const [initializingDotCount, setInitializingDotCount] = useState(1);

  const creatingSessionRef = useRef(false);
  const prevStreamingRef = useRef(false);
  const processedMemoryResultsRef = useRef(0);
  const lastErrorRef = useRef<string | null>(null);
  const chatViewportRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const previousStatusRef = useRef<"connecting" | "connected" | "disconnected" | "error">("connecting");

  const sessionRef = useRef<UseSessionResult | null>(null);
  const approvalRef = useRef<UseApprovalResult | null>(null);

  const appendMessages = useCallback((incoming: ChatMessage[]): void => {
    if (incoming.length === 0) return;
    setMessages((prev) => mergeContiguousMessages(prev, incoming));
  }, []);

  const appendSystem = useCallback((text: string): void => {
    appendMessages([{ id: makeId(), role: "system", text }]);
  }, [appendMessages]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto"): void => {
    const viewport = chatViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }, []);

  const handleChatScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget;
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < 40;
  }, []);

  const requestAutoScroll = useCallback((behavior: ScrollBehavior = "auto"): void => {
    shouldAutoScrollRef.current = true;
    requestAnimationFrame(() => scrollToBottom(behavior));
  }, [scrollToBottom]);

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
      if (status === "disconnected" || status === "error") {
        appendSystem(`Connection ${status}`);
      }
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
      const next: ChatMessage[] = [];
      for (const tool of session.toolCalls) {
        const icon = tool.status === "completed" ? "+" : tool.status === "failed" ? "x" : "~";
        next.push({ id: makeId(), role: "system", text: `${icon} ${tool.tool}` });
      }
      if (session.responseText.trim()) {
        next.push({ id: makeId(), role: "assistant", text: session.responseText });
      }
      appendMessages(next);
    }
    prevStreamingRef.current = session.isStreaming;
  }, [appendMessages, session.isStreaming, session.responseText, session.toolCalls]);

  useEffect(() => {
    if (session.memoryResults.length <= processedMemoryResultsRef.current) return;
    const freshEvents = session.memoryResults.slice(processedMemoryResultsRef.current);
    processedMemoryResultsRef.current = session.memoryResults.length;
    const rendered = freshEvents.flatMap((event) => formatMemoryResult(event));
    appendMessages(rendered);
  }, [appendMessages, session.memoryResults]);

  useEffect(() => {
    if (!session.error) return;
    if (session.error === lastErrorRef.current) return;
    lastErrorRef.current = session.error;
    appendSystem(`Error: ${session.error}`);
  }, [appendSystem, session.error]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    scrollToBottom("auto");
  }, [messages, session.responseText, session.thinkingText, session.isStreaming, scrollToBottom]);

  const runtimeIds = useMemo(() => {
    const runtimeSet = new Set<string>();
    for (const runtimeId of Object.keys(session.modelCatalog)) runtimeSet.add(runtimeId);
    for (const runtimeId of Object.keys(session.runtimeDefaults)) runtimeSet.add(runtimeId);
    for (const runtimeId of Object.keys(session.runtimeHealth)) runtimeSet.add(runtimeId);
    const preferredRuntime = normalizeSelection(preferredRuntimeId);
    if (preferredRuntime) runtimeSet.add(preferredRuntime);
    if (session.sessionRuntimeId) runtimeSet.add(session.sessionRuntimeId);
    return Array.from(runtimeSet).sort();
  }, [preferredRuntimeId, session.modelCatalog, session.runtimeDefaults, session.runtimeHealth, session.sessionRuntimeId]);

  const selectedRuntimeValue = normalizeSelection(preferredRuntimeId) ?? session.sessionRuntimeId ?? runtimeIds[0] ?? "";
  const runtimeSelectorValue = selectedRuntimeValue;
  const activeRuntimeForCatalog = selectedRuntimeValue || undefined;
  const modelCatalogForRuntime = activeRuntimeForCatalog
    ? session.modelCatalog[activeRuntimeForCatalog] ?? []
    : [];
  const runtimeDefaultModel = activeRuntimeForCatalog
    ? session.runtimeDefaults[activeRuntimeForCatalog]
    : undefined;
  const modelOptions = useMemo(
    () => Array.from(new Set(
      [
        ...modelCatalogForRuntime,
        runtimeDefaultModel,
        session.sessionModel ?? undefined,
        normalizeSelection(preferredModel),
      ].filter((value): value is string => Boolean(value && value.trim().length > 0)),
    )),
    [modelCatalogForRuntime, preferredModel, runtimeDefaultModel, session.sessionModel],
  );
  const selectedModelValue = normalizeSelection(preferredModel)
    ?? session.sessionModel
    ?? runtimeDefaultModel
    ?? modelOptions[0]
    ?? "";
  const workspaceOptions = useMemo(
    () =>
      Array.from(new Set(["default", preferredWorkspaceId, session.sessionWorkspaceId].filter(isDefined))).sort(),
    [preferredWorkspaceId, session.sessionWorkspaceId],
  );

  const startSessionWithSelection = useCallback(
    (workspaceId: string, runtimeId?: string, model?: string, announce = true): void => {
      if (status !== "connected") return;

      const normalizedRuntime = normalizeSelection(runtimeId);
      const normalizedModel = normalizeSelection(model);
      const resolved = resolveModelAlias(normalizedModel ?? "", localAliases, session.modelAliases);
      const inferredRuntime = resolved.resolved
        ? inferRuntimeFromModel(resolved.resolved, session.modelRouting)
        : undefined;
      const effectiveRuntime = normalizedRuntime ?? inferredRuntime;
      const effectiveModel = resolved.resolved || undefined;

      if (!normalizedRuntime && inferredRuntime && inferredRuntime !== normalizedRuntime) {
        setPreferredRuntimeId(inferredRuntime);
      }

      createSession(effectiveRuntime, effectiveModel, workspaceId);
      if (announce) {
        appendSystem(
          `Starting session: workspace=${workspaceId}, runtime=${effectiveRuntime ?? "default"}, model=${effectiveModel ?? "default"}`,
        );
      }
      requestAutoScroll("smooth");
    },
    [
      appendSystem,
      createSession,
      localAliases,
      requestAutoScroll,
      session.modelAliases,
      session.modelRouting,
      status,
    ],
  );

  const handleApplyRuntimeModel = useCallback(() => {
    if (session.isStreaming) {
      appendSystem("Cannot switch runtime/model while streaming. Cancel current turn first.");
      return;
    }

    startSessionWithSelection(preferredWorkspaceId, preferredRuntimeId, preferredModel, true);
  }, [
    appendSystem,
    preferredModel,
    preferredRuntimeId,
    preferredWorkspaceId,
    session.isStreaming,
    startSessionWithSelection,
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
        appendMessages([{ id: makeId(), role: "user", text }]);
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

      appendMessages([{ id: makeId(), role: "user", text }]);
      requestAutoScroll("smooth");
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
      appendMessages,
      preferredModel,
      preferredRuntimeId,
      preferredWorkspaceId,
      promptInput,
      requestAutoScroll,
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
  const isSessionInitializing = status === "connected" && !session.sessionId;
  const showSessionControlPanel = false;
  const promptIsDisabled = isSessionInitializing || !session.sessionId;
  const promptPlaceholder = isSessionInitializing
    ? `Session initializing${".".repeat(initializingDotCount)}`
    : session.isStreaming
      ? "Steer the running turn..."
      : "Ask Nexus ...";

  useEffect(() => {
    if (!isSessionInitializing) {
      setInitializingDotCount(1);
      return;
    }
    const timer = setInterval(() => {
      setInitializingDotCount((count) => (count >= 3 ? 1 : count + 1));
    }, 420);
    return () => clearInterval(timer);
  }, [isSessionInitializing]);

  return (
    <div className={showSessionControlPanel ? "grid h-full min-h-0 gap-3 lg:grid-cols-[320px_minmax(0,1fr)]" : "h-full"}>
      {showSessionControlPanel ? <aside className="panel min-h-0 overflow-y-auto p-4">
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

        <Separator className="my-4" />

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

        <Separator className="my-4" />

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

        <Separator className="my-4" />

        <h3 className="panel-subtitle">Status</h3>
        <div className="text-xs leading-6 text-ink-100/90">
          <div>connection: {status}{isSessionInitializing ? " (creating session...)" : ""}</div>
          <div>session: {session.sessionId ?? (isSessionInitializing ? "(creating...)" : "(none)")}</div>
          <div>workspace: {session.sessionWorkspaceId ?? (isSessionInitializing ? "(pending)" : preferredWorkspaceId)}</div>
          <div>runtime: {session.sessionRuntimeId ?? (isSessionInitializing ? "(pending)" : (preferredRuntimeId ?? "default"))}</div>
          <div>model: {session.sessionModel ?? (isSessionInitializing ? "(pending)" : (preferredModel ?? "default"))}</div>
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
      </aside> : null}

      <section className="panel flex min-h-0 flex-col p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h1 className="panel-title">Nexus</h1>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <select
              className="input w-36 py-1.5 text-xs"
              value={preferredWorkspaceId}
              onChange={(event) => {
                if (session.isStreaming) {
                  appendSystem("Cannot switch workspace while streaming. Cancel current turn first.");
                  return;
                }
                const nextWorkspace = event.target.value || "default";
                setPreferredWorkspaceId(nextWorkspace);
                startSessionWithSelection(nextWorkspace, preferredRuntimeId, preferredModel, false);
              }}
              aria-label="Workspace"
            >
              {workspaceOptions.map((workspaceId) => (
                <option key={workspaceId} value={workspaceId}>{workspaceId}</option>
              ))}
            </select>
            <select
              className="input w-40 py-1.5 text-xs"
              value={runtimeSelectorValue}
              onChange={(event) => {
                if (session.isStreaming) {
                  appendSystem("Cannot switch runtime while streaming. Cancel current turn first.");
                  return;
                }
                const nextRuntime = event.target.value || undefined;
                setPreferredRuntimeId(nextRuntime);
                setPreferredModel(undefined);
                startSessionWithSelection(preferredWorkspaceId, nextRuntime, undefined, false);
              }}
              disabled={session.isStreaming}
              aria-label="Runtime"
            >
              <option value="">default runtime</option>
              {runtimeIds.map((runtimeId) => (
                <option key={runtimeId} value={runtimeId}>{runtimeId}</option>
              ))}
            </select>
            <select
              className="input w-56 py-1.5 text-xs"
              value={selectedModelValue}
              onChange={(event) => {
                if (session.isStreaming) {
                  appendSystem("Cannot switch model while streaming. Cancel current turn first.");
                  return;
                }
                const nextModel = event.target.value || undefined;
                setPreferredModel(nextModel);
                startSessionWithSelection(preferredWorkspaceId, selectedRuntimeValue || undefined, nextModel, false);
              }}
              disabled={session.isStreaming}
              aria-label="Model"
            >
              <option value="">default model</option>
              {modelOptions.map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          </div>
        </div>

        <ScrollArea
          className="min-h-0 flex-1 pr-1"
          viewportRef={chatViewportRef}
          onViewportScroll={handleChatScroll}
        >
          <div className="space-y-3">
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

            {session.isStreaming ? (
              <article className="message message-assistant message-streaming">
                <header className="message-role">assistant (streaming)</header>
                {session.thinkingText ? (
                  <p className="mb-3 whitespace-pre-wrap text-xs italic text-ink-100/65">{session.thinkingText}</p>
                ) : null}
                {session.responseText ? (
                  <MarkdownView text={session.responseText} />
                ) : (
                  <WaitingFirstToken />
                )}
              </article>
            ) : null}
          </div>
        </ScrollArea>

        {session.activeTools.length > 0 ? (
          <div className="mb-3 mt-3 rounded-lg border border-pulse-500/25 bg-ink-900/75 px-3 py-2 text-xs text-pulse-300">
            {session.activeTools.map((tool) => `~ ${tool.tool}`).join("  ")}
          </div>
        ) : null}

        {currentApproval ? (
          <div className="mb-3 mt-3 rounded-lg border border-yellow-400/45 bg-yellow-500/10 p-3">
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

        <div className="mt-3 border-t border-white/10 pt-3">
          <form onSubmit={handleSendPrompt} className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
            <input
              className="input"
              value={promptInput}
              onChange={(event) => setPromptInput(event.target.value)}
              placeholder={promptPlaceholder}
              disabled={promptIsDisabled}
            />
            <button type="submit" className="button-primary" disabled={promptIsDisabled}>
              {session.isStreaming ? "Steer" : "Send"}
            </button>
            <button type="button" className="button-secondary" onClick={handleCancel} disabled={!session.isStreaming}>
              Cancel
            </button>
            <button type="button" className="button-secondary" onClick={handleRecoverStream}>
              Recover
            </button>
          </form>
        </div>
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
      <div className="mx-auto flex h-full w-full max-w-3xl items-center justify-center">
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
