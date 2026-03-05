import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Box, Text } from "ink";
import { useConnection, useSession, useApproval } from "@nexus/client-core";
import type { GatewayEvent } from "@nexus/types";
import { StatusBar } from "./components/StatusBar.js";
import { Chat, type ChatMessage } from "./components/Chat.js";
import { Input } from "./components/Input.js";
import { ToolStatus } from "./components/ToolStatus.js";
import { ApprovalPrompt } from "./components/ApprovalPrompt.js";
import { TransferPrompt } from "./components/TransferPrompt.js";
import { createTuiAuthProofProvider } from "./auth/provider.js";

export interface AppProps {
  url: string;
  token: string;
}

const parseModelRoutingEnv = (): Record<string, string> => {
  const raw = process.env.NEXUS_MODEL_ROUTING;
  if (!raw) return {};
  const mappings: Record<string, string> = {};
  for (const item of raw.split(",")) {
    const [model, runtime] = item.split("=").map((v) => v.trim());
    if (model && runtime) {
      mappings[model.toLowerCase()] = runtime;
    }
  }
  return mappings;
};

const inferRuntimeFromModel = (
  model: string,
  gatewayRouting: Record<string, string>,
): string | undefined => {
  const normalized = model.trim().toLowerCase();
  if (gatewayRouting[normalized]) return gatewayRouting[normalized];
  const envMappings = parseModelRoutingEnv();
  if (envMappings[normalized]) return envMappings[normalized];

  if (/(sonnet|opus|haiku|claude)/.test(normalized)) return "claude";
  if (/(gpt|codex|o1|o3|o4)/.test(normalized)) return "codex";
  return undefined;
};

const compact = (text: string, max: number = 110): string => {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 3)}...`;
};

const normalizePrincipalIdInput = (
  principalId: string,
  principalType: "user" | "service_account",
): string => {
  const duplicatedPrefix = `${principalType}:${principalType}:`;
  if (principalId.startsWith(duplicatedPrefix)) {
    return `${principalType}:${principalId.slice(duplicatedPrefix.length)}`;
  }
  return principalId;
};

const formatUsageResult = (
  event: ReturnType<typeof useSession>["usageResults"][number],
): ChatMessage[] => {
  switch (event.action) {
    case "summary":
      return [
        { role: "system", text: "  Usage summary:" },
        {
          role: "system",
          text: `    tokens=input:${event.summary.tokens.input}, output:${event.summary.tokens.output}, total:${event.summary.tokens.total}`,
        },
        {
          role: "system",
          text: `    executions=total:${event.summary.executions.total}, queued:${event.summary.executions.queued}, running:${event.summary.executions.running}, succeeded:${event.summary.executions.succeeded}, failed:${event.summary.executions.failed}, cancelled:${event.summary.executions.cancelled}, timed_out:${event.summary.executions.timedOut}`,
        },
        ...(event.summary.memory
          ? [
              {
                role: "system" as const,
                text: `    memory.session=facts:${event.summary.memory.session.facts}, summaries:${event.summary.memory.session.summaries}, total:${event.summary.memory.session.total}, tokens:${event.summary.memory.session.memoryTokens}`,
              },
              {
                role: "system" as const,
                text: `    memory.workspace=facts:${event.summary.memory.workspace.facts}, summaries:${event.summary.memory.workspace.summaries}, total:${event.summary.memory.workspace.total}, tokens:${event.summary.memory.workspace.memoryTokens}`,
              },
            ]
          : []),
      ];
    case "stats":
      {
      const scopeLabel = `scope=${event.scope}`;
      return [
        { role: "system", text: `  Memory stats (${scopeLabel}):` },
        {
          role: "system",
          text: `    memory=facts:${event.stats.facts}, summaries:${event.stats.summaries}, total:${event.stats.total}, tokens:${event.stats.memoryTokens}`,
        },
        {
          role: "system",
          text: `    transcript=messages:${event.stats.transcriptMessages}, tokens:${event.stats.transcriptTokens}`,
        },
      ];
      }
    case "recent":
      {
      const scopeLabel = `scope=${event.scope}`;
      if (event.items.length === 0) {
        return [{ role: "system", text: `  No memory items found (recent ${event.limit}, ${scopeLabel}).` }];
      }
      return [
        { role: "system", text: `  Recent memory (${event.items.length}/${event.limit}, ${scopeLabel}):` },
        ...event.items.map((item) => ({
          role: "system" as const,
          text: `    - [${item.kind}] c=${item.confidence.toFixed(2)} ${compact(item.content)}`,
        })),
      ];
      }
    case "search":
      {
      const scopeLabel = `scope=${event.scope}`;
      if (event.items.length === 0) {
        return [{ role: "system", text: `  No memory matches for "${event.query}" (${scopeLabel}).` }];
      }
      return [
        { role: "system", text: `  Memory search "${event.query}" (${event.items.length}/${event.limit}, ${scopeLabel}):` },
        ...event.items.map((item) => ({
          role: "system" as const,
          text: `    - [${item.kind}] c=${item.confidence.toFixed(2)} ${compact(item.content)}`,
        })),
      ];
      }
    case "context":
      {
      const scopeLabel = `scope=${event.scope}`;
      return [
        {
          role: "system",
          text: `  Memory context (${scopeLabel}) for "${compact(event.prompt, 80)}": tokens=${event.context.totalTokens}/${event.context.budgetTokens}, hot=${event.context.hot.length}, warm=${event.context.warm.length}, cold=${event.context.cold.length}`,
        },
      ];
      }
    case "clear":
      {
      const scopeLabel = `scope=${event.scope}`;
      return [{ role: "system", text: `  Cleared ${event.deleted} memory item(s) (${scopeLabel}).` }];
      }
  }
};

const formatSessionListResult = (
  sessions: ReturnType<typeof useSession>["sessionList"],
  limit: number,
  activeSessionId: string | null,
  hasMore: boolean,
): ChatMessage[] => {
  if (sessions.length === 0) {
    return [{ role: "system", text: "  No sessions found." }];
  }
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const shown = sessions.slice(0, boundedLimit);
  return [
    { role: "system", text: `  Sessions (${shown.length}/${sessions.length}):` },
    ...shown.map((session) => ({
      role: "system" as const,
      text: `    - ${session.id}${session.id === activeSessionId ? " (current)" : ""} status=${session.status} workspace=${session.workspaceId ?? "default"} model=${session.model} last=${session.lastActivityAt}`,
    })),
    ...(hasMore ? [{ role: "system" as const, text: "  More sessions available. Use /session list next." }] : []),
  ];
};

export const App = ({ url, token }: AppProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [preferredRuntimeId, setPreferredRuntimeId] = useState<string | undefined>(
    process.env.NEXUS_RUNTIME?.trim() || undefined,
  );
  const [preferredWorkspaceId, setPreferredWorkspaceId] = useState<string>(
    process.env.NEXUS_WORKSPACE?.trim() || "default",
  );
  const [preferredModel, setPreferredModel] = useState<string | undefined>(
    process.env.NEXUS_MODEL?.trim() || undefined,
  );
  const [localAliases, setLocalAliases] = useState<Record<string, string>>({});
  const markdownRenderer = process.env.NEXUS_TUI_MARKDOWN_RENDERER === "plain"
    ? "plain"
    : "basic";
  const creatingSessionRef = useRef(false);

  // Use refs to break the circular dependency between handleEvent and hooks
  const sessionRef = useRef<ReturnType<typeof useSession>>(null!);
  const approvalRef = useRef<ReturnType<typeof useApproval>>(null!);

  const handleEvent = useCallback((event: GatewayEvent) => {
    sessionRef.current?.handleEvent(event);
    approvalRef.current?.handleEvent(event);

    if (event.type === "turn_end") {
      // Finalize streamed text into a message
      setMessages((prev) => {
        // responseText is tracked via the session hook, but we can't access it
        // synchronously here. Instead, we'll handle finalization in an effect.
        return prev;
      });
    }
  }, []);

  const authProvider = useMemo(() => createTuiAuthProofProvider(), []);
  const { status, sendMessage } = useConnection({
    url,
    token,
    onEvent: handleEvent,
    auth: {
      provider: authProvider,
      autoRespondToChallenge: true,
    },
  });
  const session = useSession(sendMessage);
  const approval = useApproval(sendMessage);

  // Keep refs current
  sessionRef.current = session;
  approvalRef.current = approval;

  // Finalize response into messages when streaming stops
  const prevStreamingRef = useRef(false);
  const previousSessionIdRef = useRef<string | null>(null);
  const processedUsageResultsRef = useRef(0);
  const lastErrorRef = useRef<string | null>(null);
  const pendingSessionListLimitRef = useRef<number | null>(null);
  const sessionListLimitRef = useRef(10);
  useEffect(() => {
    if (prevStreamingRef.current && !session.isStreaming) {
      setMessages((prev) => {
        const newMessages: ChatMessage[] = [];
        // Add tool call history as system messages
        for (const tc of session.toolCalls) {
          const icon = tc.status === "completed" ? "+" : tc.status === "failed" ? "x" : "~";
          newMessages.push({ role: "system", text: `  ${icon} ${tc.tool}` });
        }
        // Add assistant text if any
        if (session.responseText) {
          newMessages.push({ role: "assistant", text: session.responseText });
        }
        return newMessages.length > 0 ? [...prev, ...newMessages] : prev;
      });
    }
    prevStreamingRef.current = session.isStreaming;
  }, [session.isStreaming, session.responseText, session.toolCalls]);

  useEffect(() => {
    if (session.usageResults.length <= processedUsageResultsRef.current) return;
    const next = session.usageResults.slice(processedUsageResultsRef.current);
    processedUsageResultsRef.current = session.usageResults.length;
    const rendered = next.flatMap((event) => formatUsageResult(event));
    setMessages((prev) => [...prev, ...rendered]);
  }, [session.usageResults]);

  useEffect(() => {
    if (!session.error) return;
    if (session.error === lastErrorRef.current) return;
    lastErrorRef.current = session.error;
    setMessages((prev) => [...prev, { role: "system", text: `  Error: ${session.error}` }]);
  }, [session.error]);

  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    const nextSessionId = session.sessionId;
    if (previousSessionId === nextSessionId) return;

    if (!previousSessionId && nextSessionId) {
      setMessages((prev) => [
        ...prev,
        { role: "system", text: "  ----- Session attached -----" },
        { role: "system", text: `    session=${nextSessionId}` },
        { role: "system", text: `    workspace=${session.sessionWorkspaceId ?? preferredWorkspaceId}` },
        { role: "system", text: `    runtime=${session.sessionRuntimeId ?? preferredRuntimeId ?? "default"}` },
        { role: "system", text: `    model=${session.sessionModel ?? preferredModel ?? "runtime-default"}` },
      ]);
    } else if (previousSessionId && nextSessionId) {
      setMessages((prev) => [
        ...prev,
        { role: "system", text: "  ----- Session switched -----" },
        { role: "system", text: `    from=${previousSessionId}` },
        { role: "system", text: `    to=${nextSessionId}` },
        { role: "system", text: `    workspace=${session.sessionWorkspaceId ?? preferredWorkspaceId}` },
        { role: "system", text: `    runtime=${session.sessionRuntimeId ?? preferredRuntimeId ?? "default"}` },
        { role: "system", text: `    model=${session.sessionModel ?? preferredModel ?? "runtime-default"}` },
      ]);
    } else if (previousSessionId && !nextSessionId) {
      setMessages((prev) => [
        ...prev,
        { role: "system", text: "  ----- Session detached -----" },
        { role: "system", text: `    previous=${previousSessionId}` },
        { role: "system", text: "    No active session." },
      ]);
    }

    previousSessionIdRef.current = nextSessionId;
  }, [
    preferredModel,
    preferredRuntimeId,
    preferredWorkspaceId,
    session.sessionId,
    session.sessionModel,
    session.sessionRuntimeId,
    session.sessionWorkspaceId,
  ]);

  useEffect(() => {
    const pendingLimit = pendingSessionListLimitRef.current;
    if (pendingLimit === null) return;
    pendingSessionListLimitRef.current = null;
    const rendered = formatSessionListResult(
      session.sessionList,
      pendingLimit,
      session.sessionId,
      session.sessionListHasMore,
    );
    setMessages((prev) => [...prev, ...rendered]);
  }, [session.sessionId, session.sessionList, session.sessionListHasMore]);

  const createSession = useCallback(
    (runtimeId?: string, model?: string, workspaceId?: string) => {
      sendMessage({ type: "session_new", runtimeId, model, workspaceId: workspaceId ?? preferredWorkspaceId });
    },
    [preferredWorkspaceId, sendMessage],
  );

  // On first connect: create a session. On reconnect: replay current session transcript.
  const previousStatusRef = useRef(status);
  useEffect(() => {
    const wasConnected = previousStatusRef.current === "connected";
    const isConnected = status === "connected";
    previousStatusRef.current = status;
    if (!isConnected || wasConnected) return;

    if (session.sessionId) {
      session.requestReplay(session.sessionId);
    }
  }, [session.sessionId, session.requestReplay, status]);

  useEffect(() => {
    if (status !== "connected") {
      creatingSessionRef.current = false;
      return;
    }
    if (session.sessionId) {
      creatingSessionRef.current = false;
      return;
    }
    if (creatingSessionRef.current) {
      return;
    }
    creatingSessionRef.current = true;
    createSession(preferredRuntimeId, preferredModel);
  }, [createSession, preferredModel, preferredRuntimeId, session.sessionId, status]);

  const handleRuntimeCommand = useCallback(
    (runtimeArg: string) => {
      const runtimeId = runtimeArg.trim();
      if (!runtimeId) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            text: `  Runtime: ${preferredRuntimeId ?? "default"}${preferredModel ? `, model: ${preferredModel}` : ""}`,
          },
        ]);
        return;
      }

      setPreferredRuntimeId(runtimeId);
      if (status !== "connected") {
        setMessages((prev) => [...prev, { role: "system", text: `  Runtime set to ${runtimeId}. Will apply when connected.` }]);
        return;
      }
      setMessages((prev) => [...prev, { role: "system", text: `  Runtime set to ${runtimeId}. Starting new session...` }]);
      createSession(runtimeId, preferredModel, preferredWorkspaceId);
    },
    [createSession, preferredModel, preferredRuntimeId, preferredWorkspaceId, status],
  );

  const resolveModelInput = useCallback(
    (inputModel: string): { requested: string; resolved: string } => {
      const normalized = inputModel.trim().toLowerCase();
      const fromLocal = localAliases[normalized];
      if (fromLocal) {
        return { requested: inputModel.trim(), resolved: fromLocal };
      }
      const fromGateway = session.modelAliases[normalized];
      if (fromGateway) {
        return { requested: inputModel.trim(), resolved: fromGateway };
      }
      return { requested: inputModel.trim(), resolved: inputModel.trim() };
    },
    [localAliases, session.modelAliases],
  );

  const handleModelsCommand = useCallback(() => {
    const catalog = session.modelCatalog;
    const runtimeIds = Object.keys(catalog);
    if (runtimeIds.length === 0) {
      setMessages((prev) => [
        ...prev,
        { role: "system", text: "  No model catalog from gateway. Configure modelCatalog in gateway config." },
      ]);
      return;
    }

    const lines: ChatMessage[] = [];
    lines.push({ role: "system", text: "  Available models:" });
    for (const runtimeId of runtimeIds.sort()) {
      const defaultModel = session.runtimeDefaults[runtimeId] ?? "(none)";
      lines.push({ role: "system", text: `  [${runtimeId}] default=${defaultModel}` });
      for (const modelId of catalog[runtimeId] ?? []) {
        const aliases = [
          ...Object.entries(session.modelAliases)
            .filter(([, target]) => target === modelId)
            .map(([alias]) => alias),
          ...Object.entries(localAliases)
            .filter(([, target]) => target === modelId)
            .map(([alias]) => `${alias}*`),
        ];
        const aliasText = aliases.length > 0 ? ` aliases=${aliases.join(",")}` : "";
        lines.push({ role: "system", text: `    - ${modelId}${aliasText}` });
      }
    }
    lines.push({ role: "system", text: "  * local alias (TUI-only)" });
    setMessages((prev) => [...prev, ...lines]);
  }, [localAliases, session.modelAliases, session.modelCatalog, session.runtimeDefaults]);

  const handleAliasCommand = useCallback(
    (aliasArg: string) => {
      const parts = aliasArg.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        const allAliases = Object.entries(localAliases);
        if (allAliases.length === 0) {
          setMessages((prev) => [...prev, { role: "system", text: "  No local aliases. Usage: /alias <nickname> <model-id>" }]);
          return;
        }
        setMessages((prev) => [
          ...prev,
          { role: "system", text: "  Local aliases:" },
          ...allAliases.map(([alias, model]) => ({ role: "system" as const, text: `    - ${alias} -> ${model}` })),
        ]);
        return;
      }

      if (parts.length < 2) {
        setMessages((prev) => [...prev, { role: "system", text: "  Usage: /alias <nickname> <model-id>" }]);
        return;
      }

      const alias = parts[0]!.toLowerCase();
      const modelId = parts.slice(1).join(" ");
      setLocalAliases((prev) => ({ ...prev, [alias]: modelId }));
      setMessages((prev) => [...prev, { role: "system", text: `  Alias set: ${alias} -> ${modelId}` }]);
    },
    [localAliases],
  );

  const handleStatusCommand = useCallback(() => {
    const activeRuntime = session.sessionRuntimeId ?? preferredRuntimeId ?? "default";
    const activeWorkspace = session.sessionWorkspaceId ?? preferredWorkspaceId;
    const activeModel = session.sessionModel ?? preferredModel ?? "(unknown)";
    const activePrincipalType = session.sessionPrincipalType ?? "user";
    const activePrincipalId = session.sessionPrincipalId ?? "user:local";
    const activeSource = session.sessionSource ?? "interactive";
    const authPrincipalType = session.authPrincipalType ?? "user";
    const authPrincipalId = session.authPrincipalId ?? "(unverified)";
    const catalogRuntimes = Object.keys(session.modelCatalog).length;
    const catalogModels = Object.values(session.modelCatalog).reduce((acc, models) => acc + models.length, 0);
    const aliasCount = Object.keys(session.modelAliases).length + Object.keys(localAliases).length;
    const runtimeHealthLines = Object.entries(session.runtimeHealth);

    setMessages((prev) => [
      ...prev,
      { role: "system", text: "  Status:" },
      { role: "system", text: `    connection=${status}` },
      { role: "system", text: `    session=${session.sessionId ?? "(none)"}` },
      { role: "system", text: `    workspace=${activeWorkspace}` },
      { role: "system", text: `    principal=${activePrincipalId} (type=${activePrincipalType})` },
      { role: "system", text: `    auth_principal=${authPrincipalId} (type=${authPrincipalType})` },
      { role: "system", text: `    source=${activeSource}` },
      { role: "system", text: `    runtime=${activeRuntime}` },
      { role: "system", text: `    model=${activeModel}` },
      { role: "system", text: `    streaming=${session.isStreaming ? "yes" : "no"}` },
      { role: "system", text: `    active_tools=${session.activeTools.length}` },
      { role: "system", text: `    pending_approvals=${approval.pendingApprovals.length}` },
      { role: "system", text: `    catalog=runtimes:${catalogRuntimes}, models:${catalogModels}` },
      { role: "system", text: `    aliases=gateway:${Object.keys(session.modelAliases).length}, local:${Object.keys(localAliases).length}, total:${aliasCount}` },
      ...(runtimeHealthLines.length === 0
        ? [{ role: "system" as const, text: "    runtime_health=(none reported yet)" }]
        : runtimeHealthLines
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([runtimeId, health]) => ({
            role: "system" as const,
            text: `    runtime_health.${runtimeId}=${health.status}${health.reason ? ` (${health.reason})` : ""}`,
          }))),
    ]);
  }, [
    approval.pendingApprovals.length,
    localAliases,
    preferredModel,
    preferredRuntimeId,
    preferredWorkspaceId,
    session.activeTools.length,
    session.isStreaming,
    session.modelAliases,
    session.modelCatalog,
    session.runtimeHealth,
    session.sessionPrincipalId,
    session.sessionPrincipalType,
    session.sessionId,
    session.sessionModel,
    session.sessionRuntimeId,
    session.sessionSource,
    session.sessionWorkspaceId,
    status,
  ]);

  const handleTransferCommand = useCallback(
    (transferArg: string, options?: { deprecatedAlias?: boolean }) => {
      if (options?.deprecatedAlias) {
        setMessages((prev) => [...prev, { role: "system", text: "  Deprecated: use /session transfer ... (legacy /transfer still works for now)." }]);
      }
      const parts = transferArg.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      const pendingTransfers = session.pendingSessionTransfers.filter((transfer) => {
        if (!session.authPrincipalId) return true;
        const authType = session.authPrincipalType ?? "user";
        return transfer.targetPrincipalId === session.authPrincipalId
          && transfer.targetPrincipalType === authType;
      });
      const currentTransfer = pendingTransfers[0];

      if (!sub || sub === "pending") {
        if (pendingTransfers.length === 0) {
          setMessages((prev) => [...prev, { role: "system", text: "  No pending transfer requests." }]);
          return;
        }
        setMessages((prev) => [
          ...prev,
          { role: "system", text: `  Pending transfers (${pendingTransfers.length}):` },
          ...pendingTransfers.map((transfer) => ({
            role: "system" as const,
            text: `    - session=${transfer.sessionId} from=${transfer.fromPrincipalType}:${transfer.fromPrincipalId} expires=${transfer.expiresAt}`,
          })),
        ]);
        return;
      }

      if (sub === "request") {
        const targetPrincipalRaw = parts[1];
        const targetPrincipalTypeRaw = parts[2]?.toLowerCase();
        const targetPrincipalType = targetPrincipalTypeRaw === "service_account" ? "service_account" : "user";
        const expiresInMsRaw = parts[3];
        let expiresInMs: number | undefined;

        if (!targetPrincipalRaw) {
          setMessages((prev) => [...prev, { role: "system", text: "  Usage: /session transfer request <targetPrincipalId> [user|service_account] [expiresMs]" }]);
          return;
        }
        if (expiresInMsRaw) {
          const parsedExpiresInMs = Number.parseInt(expiresInMsRaw, 10);
          if (!Number.isFinite(parsedExpiresInMs) || parsedExpiresInMs <= 0) {
            setMessages((prev) => [...prev, { role: "system", text: "  Usage: /session transfer request <targetPrincipalId> [user|service_account] [expiresMs]" }]);
            return;
          }
          expiresInMs = parsedExpiresInMs;
        }

        const targetPrincipalId = normalizePrincipalIdInput(targetPrincipalRaw, targetPrincipalType);
        session.requestSessionTransfer(targetPrincipalId, targetPrincipalType, expiresInMs);
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            text: `  Transfer requested for current session -> ${targetPrincipalType}:${targetPrincipalId}${expiresInMs ? ` (ttl=${expiresInMs}ms)` : ""}`,
          },
        ]);
        return;
      }

      if (sub === "accept") {
        const explicitSessionId = parts[1] ?? currentTransfer?.sessionId;
        if (!explicitSessionId) {
          setMessages((prev) => [...prev, { role: "system", text: "  Usage: /session transfer accept [sessionId]" }]);
          return;
        }
        session.acceptSessionTransfer(explicitSessionId);
        setMessages((prev) => [...prev, { role: "system", text: `  Accepting transfer for session ${explicitSessionId}...` }]);
        return;
      }

      if (sub === "dismiss" || sub === "ignore") {
        const explicitSessionId = parts[1] ?? currentTransfer?.sessionId;
        if (!explicitSessionId) {
          setMessages((prev) => [...prev, { role: "system", text: "  Usage: /session transfer dismiss [sessionId]" }]);
          return;
        }
        session.dismissPendingSessionTransfer(explicitSessionId);
        setMessages((prev) => [...prev, { role: "system", text: `  Dismissed transfer prompt for session ${explicitSessionId}.` }]);
        return;
      }

      setMessages((prev) => [...prev, { role: "system", text: "  Usage: /session transfer pending | request <targetPrincipalId> [user|service_account] [expiresMs] | accept [sessionId] | dismiss [sessionId]" }]);
    },
    [session],
  );

  const handleSessionCommand = useCallback(
    (sessionArg: string) => {
      const parts = sessionArg.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();
      if (!sub || sub === "help") {
        setMessages((prev) => [
          ...prev,
          { role: "system", text: "  Usage: /session <command>" },
          { role: "system", text: "    /session list [limit|next [limit]]" },
          { role: "system", text: "    /session resume <sessionId>" },
          { role: "system", text: "    /session takeover <sessionId>" },
          { role: "system", text: "    /session transfer pending|request|accept|dismiss" },
          { role: "system", text: "    /session close [sessionId]" },
        ]);
        return;
      }

      if (sub === "list") {
        const rawArg = parts[1]?.toLowerCase();
        const isNext = rawArg === "next";
        const limitArg = isNext ? parts[2] : parts[1];
        const requestedLimit = limitArg ? Number.parseInt(limitArg, 10) : undefined;
        if (limitArg && (!Number.isFinite(requestedLimit) || (requestedLimit ?? 0) <= 0)) {
          setMessages((prev) => [...prev, { role: "system", text: "  Usage: /session list [limit|next [limit]]" }]);
          return;
        }
        const limit = requestedLimit ?? sessionListLimitRef.current;
        if (isNext) {
          if (!session.sessionListHasMore || !session.sessionListNextCursor) {
            setMessages((prev) => [...prev, { role: "system", text: "  No additional sessions in the current list window." }]);
            return;
          }
          pendingSessionListLimitRef.current = limit;
          sessionListLimitRef.current = limit;
          setMessages((prev) => [...prev, { role: "system", text: "  Fetching next sessions page..." }]);
          session.requestSessionList({ limit, cursor: session.sessionListNextCursor });
          return;
        }
        pendingSessionListLimitRef.current = limit;
        sessionListLimitRef.current = limit;
        setMessages((prev) => [...prev, { role: "system", text: "  Fetching sessions..." }]);
        session.requestSessionList({ limit });
        return;
      }

      if (sub === "resume" || sub === "takeover") {
        const sessionId = parts[1];
        if (!sessionId) {
          setMessages((prev) => [...prev, { role: "system", text: `  Usage: /session ${sub} <sessionId>` }]);
          return;
        }
        session.resumeSession(sessionId);
        setMessages((prev) => [...prev, { role: "system", text: `  ${sub === "takeover" ? "Taking over" : "Resuming"} session ${sessionId}...` }]);
        return;
      }

      if (sub === "transfer") {
        handleTransferCommand(parts.slice(1).join(" "));
        return;
      }

      if (sub === "close" || sub === "delete") {
        const explicitSessionId = parts[1] ?? session.sessionId ?? undefined;
        if (!explicitSessionId) {
          setMessages((prev) => [...prev, { role: "system", text: `  Usage: /session ${sub} [sessionId]` }]);
          return;
        }
        if (sub === "delete") {
          setMessages((prev) => [...prev, { role: "system", text: "  Hard delete is not supported yet; closing session instead." }]);
        }
        sendMessage({ type: "session_close", sessionId: explicitSessionId });
        setMessages((prev) => [...prev, { role: "system", text: `  Closing session ${explicitSessionId}...` }]);
        return;
      }

      setMessages((prev) => [...prev, { role: "system", text: "  Usage: /session [list|resume|takeover|transfer|close]" }]);
    },
    [handleTransferCommand, sendMessage, session],
  );

  const parseMemoryScope = (
    value: string | undefined,
  ): "session" | "workspace" | "hybrid" | undefined => {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized === "session" || normalized === "workspace" || normalized === "hybrid") {
      return normalized;
    }
    return undefined;
  };

  const handleWorkspaceCommand = useCallback(
    (workspaceArg: string) => {
      const workspaceId = workspaceArg.trim();
      if (!workspaceId) {
        setMessages((prev) => [...prev, { role: "system", text: `  Workspace: ${preferredWorkspaceId}` }]);
        return;
      }
      setPreferredWorkspaceId(workspaceId);
      if (status !== "connected") {
        setMessages((prev) => [...prev, { role: "system", text: `  Workspace set to ${workspaceId}. Will apply when connected.` }]);
        return;
      }
      setMessages((prev) => [...prev, { role: "system", text: `  Workspace set to ${workspaceId}. Starting new session...` }]);
      createSession(preferredRuntimeId, preferredModel, workspaceId);
    },
    [createSession, preferredModel, preferredRuntimeId, preferredWorkspaceId, status],
  );

  const handleUsageCommand = useCallback(
    (usageArg: string) => {
      if (!session.sessionId) {
        setMessages((prev) => [...prev, { role: "system", text: "  No active session for usage commands." }]);
        return;
      }

      const parts = usageArg.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();
      if (!sub) {
        session.requestUsage({ action: "summary" });
        return;
      }

      if (sub === "summary") {
        session.requestUsage({ action: "summary" });
        return;
      }

      if (sub === "stats") {
        const scope = parseMemoryScope(parts[1]);
        if (parts[1] && !scope) {
          setMessages((prev) => [...prev, { role: "system", text: "  Usage: /usage stats [session|workspace]" }]);
          return;
        }
        session.requestUsage({ action: "stats", scope: scope === "hybrid" ? "session" : scope });
        return;
      }

      if (sub === "recent") {
        let parsedLimit: number | undefined;
        let scopeRaw: string | undefined;
        const firstArg = parts[1];
        const firstScope = parseMemoryScope(firstArg);
        if (firstArg && firstScope) {
          scopeRaw = firstArg;
        } else if (firstArg) {
          parsedLimit = Number.parseInt(firstArg, 10);
          if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
            setMessages((prev) => [...prev, { role: "system", text: "  Usage: /usage recent [n] [session|workspace]" }]);
            return;
          }
          scopeRaw = parts[2];
        }
        const scope = parseMemoryScope(scopeRaw);
        if (scopeRaw && !scope) {
          setMessages((prev) => [...prev, { role: "system", text: "  Usage: /usage recent [n] [session|workspace]" }]);
          return;
        }
        session.requestUsage({ action: "recent", limit: parsedLimit, scope: scope === "hybrid" ? "session" : scope });
        return;
      }

      if (sub === "search") {
        const query = parts.slice(1).join(" ").trim();
        if (!query) {
          setMessages((prev) => [...prev, { role: "system", text: "  Usage: /usage search <query>" }]);
          return;
        }
        const maybeScope = parseMemoryScope(parts.slice(-1)[0]);
        const consumedScope = maybeScope ? parts.slice(-1)[0] : undefined;
        const queryParts = consumedScope ? parts.slice(1, -1) : parts.slice(1);
        const scopedQuery = queryParts.join(" ").trim();
        if (!scopedQuery) {
          setMessages((prev) => [...prev, { role: "system", text: "  Usage: /usage search <query> [session|workspace]" }]);
          return;
        }
        session.requestUsage({ action: "search", query: scopedQuery, scope: maybeScope === "hybrid" ? "session" : maybeScope });
        return;
      }

      if (sub === "context") {
        const maybeScope = parseMemoryScope(parts.slice(-1)[0]);
        const promptParts = maybeScope ? parts.slice(1, -1) : parts.slice(1);
        const prompt = promptParts.join(" ").trim();
        session.requestUsage({ action: "context", prompt: prompt || undefined, scope: maybeScope });
        return;
      }

      if (sub === "clear") {
        const scope = parseMemoryScope(parts[1]);
        if (parts[1] && !scope) {
          setMessages((prev) => [...prev, { role: "system", text: "  Usage: /usage clear [session|workspace]" }]);
          return;
        }
        session.requestUsage({ action: "clear", scope: scope === "hybrid" ? "session" : scope });
        return;
      }

      setMessages((prev) => [...prev, { role: "system", text: "  Usage: /usage [summary|stats|recent|search|context|clear] ..." }]);
    },
    [session],
  );

  const handleModelCommand = useCallback(
    (modelArg: string) => {
      const rawModel = modelArg.trim();
      if (!rawModel) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            text: `  Model: ${preferredModel ?? "default"}${preferredRuntimeId ? `, runtime: ${preferredRuntimeId}` : ""}`,
          },
        ]);
        return;
      }

      const resolved = resolveModelInput(rawModel);
      const mappedRuntime = inferRuntimeFromModel(resolved.resolved, session.modelRouting);
      setPreferredModel(resolved.requested);
      if (mappedRuntime) {
        setPreferredRuntimeId(mappedRuntime);
      }

      const runtimeText = mappedRuntime
        ? ` runtime -> ${mappedRuntime}`
        : preferredRuntimeId
          ? ` runtime -> ${preferredRuntimeId}`
          : "";
      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          text: `  Model set to ${resolved.requested}${resolved.requested !== resolved.resolved ? ` -> ${resolved.resolved}` : ""}.${runtimeText}${status === "connected" ? " Starting new session..." : " Will apply when connected."}`,
        },
      ]);
      if (status === "connected") {
        createSession(mappedRuntime ?? preferredRuntimeId, resolved.resolved, preferredWorkspaceId);
      }
    },
    [createSession, preferredModel, preferredRuntimeId, preferredWorkspaceId, resolveModelInput, session.modelRouting, status],
  );

  const handleSubmit = useCallback(
    (text: string) => {
      if (text.startsWith("/runtime")) {
        if (session.isStreaming) {
          setMessages((prev) => [...prev, { role: "system", text: "  Can't switch runtime while streaming. Press Esc to cancel current turn." }]);
          return;
        }
        handleRuntimeCommand(text.replace("/runtime", ""));
        return;
      }

      if (text.startsWith("/model")) {
        if (session.isStreaming) {
          setMessages((prev) => [...prev, { role: "system", text: "  Can't switch model while streaming. Press Esc to cancel current turn." }]);
          return;
        }
        handleModelCommand(text.replace("/model", ""));
        return;
      }

      if (text.startsWith("/workspace")) {
        if (session.isStreaming) {
          setMessages((prev) => [...prev, { role: "system", text: "  Can't switch workspace while streaming. Press Esc to cancel current turn." }]);
          return;
        }
        handleWorkspaceCommand(text.replace("/workspace", ""));
        return;
      }

      if (text.startsWith("/models")) {
        handleModelsCommand();
        return;
      }

      if (text.startsWith("/alias")) {
        if (session.isStreaming) {
          setMessages((prev) => [...prev, { role: "system", text: "  Can't edit aliases while streaming. Press Esc to cancel current turn." }]);
          return;
        }
        handleAliasCommand(text.replace("/alias", ""));
        return;
      }

      if (text.startsWith("/status")) {
        handleStatusCommand();
        return;
      }

      if (text.startsWith("/session")) {
        handleSessionCommand(text.replace("/session", ""));
        return;
      }

      if (text.startsWith("/transfer")) {
        handleTransferCommand(text.replace("/transfer", ""), { deprecatedAlias: true });
        return;
      }

      if (text.startsWith("/usage")) {
        handleUsageCommand(text.replace("/usage", ""));
        return;
      }

      if (text.startsWith("/close")) {
        if (!session.sessionId) {
          setMessages((prev) => [...prev, { role: "system", text: "  No active session to close." }]);
          return;
        }
        session.closeSession();
        setMessages((prev) => [...prev, { role: "system", text: `  Closing session ${session.sessionId}...` }]);
        return;
      }

      setMessages((prev) => [...prev, { role: "user", text }]);
      if (session.isStreaming) {
        session.steer(text);
      } else {
        session.sendPrompt(text);
      }
    },
    [handleAliasCommand, handleModelCommand, handleModelsCommand, handleRuntimeCommand, handleSessionCommand, handleStatusCommand, handleTransferCommand, handleUsageCommand, handleWorkspaceCommand, session],
  );

  const handleCancelTurn = useCallback(() => {
    if (session.isStreaming) {
      session.cancel();
      setMessages((prev) => [...prev, { role: "system", text: "  Cancelled current turn" }]);
    }
  }, [session.cancel, session.isStreaming]);

  const currentApproval = approval.pendingApprovals[0] ?? null;
  const pendingTransfers = session.pendingSessionTransfers.filter((transfer) => {
    if (!session.authPrincipalId) return true;
    const authType = session.authPrincipalType ?? "user";
    return transfer.targetPrincipalId === session.authPrincipalId
      && transfer.targetPrincipalType === authType;
  });
  const currentTransfer = pendingTransfers[0] ?? null;

  const handleApprove = useCallback(() => {
    if (currentApproval) {
      setMessages((prev) => [...prev, { role: "system", text: `  Approved: ${currentApproval.tool}` }]);
      approval.approve(currentApproval.requestId);
    }
  }, [currentApproval, approval.approve]);

  const handleApproveAll = useCallback(() => {
    const pending = approval.pendingApprovals;
    setMessages((prev) => [
      ...prev,
      ...pending.map((a) => ({ role: "system" as const, text: `  Approved: ${a.tool}` })),
    ]);
    approval.approveAll();
  }, [approval.pendingApprovals, approval.approveAll]);

  const handleDeny = useCallback(() => {
    if (currentApproval) {
      setMessages((prev) => [...prev, { role: "system", text: `  Denied: ${currentApproval.tool}` }]);
      approval.deny(currentApproval.requestId);
    }
  }, [currentApproval, approval.deny]);

  return (
    <Box flexDirection="column" padding={1}>
      <StatusBar
        status={status}
        isSessionInitializing={status === "connected" && !session.sessionId}
        model={
          session.sessionModel
            ? `${session.sessionWorkspaceId ?? preferredWorkspaceId}/${session.sessionRuntimeId ?? preferredRuntimeId ?? "default"}:${session.sessionModel}`
            : undefined
        }
      />
      <Chat
        messages={messages}
        streamingText={session.responseText}
        thinkingText={session.thinkingText}
        isStreaming={session.isStreaming}
        toolCalls={session.toolCalls}
        markdownRenderer={markdownRenderer}
      />
      <ToolStatus activeTools={session.activeTools} />
      <ApprovalPrompt
        approval={currentApproval}
        totalPending={approval.pendingApprovals.length}
        onApprove={handleApprove}
        onApproveAll={handleApproveAll}
        onDeny={handleDeny}
        onCancel={handleCancelTurn}
        canCancel={session.isStreaming}
      />
      <TransferPrompt
        transfer={currentTransfer}
        totalPending={pendingTransfers.length}
        onAccept={() => {
          if (!currentTransfer) return;
          session.acceptSessionTransfer(currentTransfer.sessionId);
          setMessages((prev) => [...prev, { role: "system", text: `  Accepting transfer for session ${currentTransfer.sessionId}...` }]);
        }}
        onDismiss={() => {
          if (!currentTransfer) return;
          session.dismissPendingSessionTransfer(currentTransfer.sessionId);
          setMessages((prev) => [...prev, { role: "system", text: `  Dismissed transfer prompt for session ${currentTransfer.sessionId}.` }]);
        }}
      />
      <Input
        onSubmit={handleSubmit}
        isDisabled={!session.sessionId}
        isFocused={!currentApproval && !currentTransfer}
        onCancel={handleCancelTurn}
        canCancel={session.isStreaming && !currentApproval}
      />
      {session.isStreaming && !currentApproval ? (
        <Text color="gray">Enter = steer, Esc = cancel current turn</Text>
      ) : null}
      {!session.isStreaming ? (
        <Text color="gray">Commands: /workspace &lt;id&gt;, /runtime &lt;id&gt;, /model &lt;name&gt;, /models, /alias &lt;nick&gt; &lt;model-id&gt;, /status, /usage ..., /session ..., /close</Text>
      ) : null}
    </Box>
  );
};
