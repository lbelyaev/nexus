import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import { useConnection, useSession, useApproval } from "@nexus/client-core";
import type { GatewayEvent } from "@nexus/types";
import { StatusBar } from "./components/StatusBar.js";
import { Chat, type ChatMessage } from "./components/Chat.js";
import { Input } from "./components/Input.js";
import { ToolStatus } from "./components/ToolStatus.js";
import { ApprovalPrompt } from "./components/ApprovalPrompt.js";

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

export const App = ({ url, token }: AppProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [preferredRuntimeId, setPreferredRuntimeId] = useState<string | undefined>(
    process.env.NEXUS_RUNTIME?.trim() || undefined,
  );
  const [preferredModel, setPreferredModel] = useState<string | undefined>(
    process.env.NEXUS_MODEL?.trim() || undefined,
  );
  const [localAliases, setLocalAliases] = useState<Record<string, string>>({});
  const markdownRenderer = process.env.NEXUS_TUI_MARKDOWN_RENDERER === "plain"
    ? "plain"
    : "basic";

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

  const { status, sendMessage } = useConnection({ url, token, onEvent: handleEvent });
  const session = useSession(sendMessage);
  const approval = useApproval(sendMessage);

  // Keep refs current
  sessionRef.current = session;
  approvalRef.current = approval;

  // Finalize response into messages when streaming stops
  const prevStreamingRef = useRef(false);
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

  const createSession = useCallback(
    (runtimeId?: string, model?: string) => {
      sendMessage({ type: "session_new", runtimeId, model });
    },
    [sendMessage],
  );

  // Auto-create session on connect
  useEffect(() => {
    if (status === "connected" && !session.sessionId) {
      createSession(preferredRuntimeId, preferredModel);
    }
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
      createSession(runtimeId, preferredModel);
    },
    [createSession, preferredModel, preferredRuntimeId, status],
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
    const activeModel = session.sessionModel ?? preferredModel ?? "(unknown)";
    const catalogRuntimes = Object.keys(session.modelCatalog).length;
    const catalogModels = Object.values(session.modelCatalog).reduce((acc, models) => acc + models.length, 0);
    const aliasCount = Object.keys(session.modelAliases).length + Object.keys(localAliases).length;

    setMessages((prev) => [
      ...prev,
      { role: "system", text: "  Status:" },
      { role: "system", text: `    connection=${status}` },
      { role: "system", text: `    session=${session.sessionId ?? "(none)"}` },
      { role: "system", text: `    runtime=${activeRuntime}` },
      { role: "system", text: `    model=${activeModel}` },
      { role: "system", text: `    streaming=${session.isStreaming ? "yes" : "no"}` },
      { role: "system", text: `    active_tools=${session.activeTools.length}` },
      { role: "system", text: `    pending_approvals=${approval.pendingApprovals.length}` },
      { role: "system", text: `    catalog=runtimes:${catalogRuntimes}, models:${catalogModels}` },
      { role: "system", text: `    aliases=gateway:${Object.keys(session.modelAliases).length}, local:${Object.keys(localAliases).length}, total:${aliasCount}` },
    ]);
  }, [
    approval.pendingApprovals.length,
    localAliases,
    preferredModel,
    preferredRuntimeId,
    session.activeTools.length,
    session.isStreaming,
    session.modelAliases,
    session.modelCatalog,
    session.sessionId,
    session.sessionModel,
    session.sessionRuntimeId,
    status,
  ]);

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
        createSession(mappedRuntime ?? preferredRuntimeId, resolved.resolved);
      }
    },
    [createSession, preferredModel, preferredRuntimeId, resolveModelInput, session.modelRouting, status],
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

      setMessages((prev) => [...prev, { role: "user", text }]);
      if (session.isStreaming) {
        session.steer(text);
      } else {
        session.sendPrompt(text);
      }
    },
    [handleAliasCommand, handleModelCommand, handleModelsCommand, handleRuntimeCommand, handleStatusCommand, session.isStreaming, session.sendPrompt, session.steer],
  );

  const handleCancelTurn = useCallback(() => {
    if (session.isStreaming) {
      session.cancel();
      setMessages((prev) => [...prev, { role: "system", text: "  Cancelled current turn" }]);
    }
  }, [session.cancel, session.isStreaming]);

  const currentApproval = approval.pendingApprovals[0] ?? null;

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
        model={
          session.sessionModel
            ? `${session.sessionRuntimeId ?? preferredRuntimeId ?? "default"}:${session.sessionModel}`
            : preferredModel
              ? `${preferredRuntimeId ?? "default"}:${preferredModel}`
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
      <Input
        onSubmit={handleSubmit}
        isDisabled={!session.sessionId}
        isFocused={!currentApproval}
        onCancel={handleCancelTurn}
        canCancel={session.isStreaming && !currentApproval}
      />
      {session.isStreaming && !currentApproval ? (
        <Text color="gray">Enter = steer, Esc = cancel current turn</Text>
      ) : null}
      {!session.isStreaming ? (
        <Text color="gray">Commands: /runtime &lt;id&gt;, /model &lt;name&gt;, /models, /alias &lt;nick&gt; &lt;model-id&gt;, /status</Text>
      ) : null}
    </Box>
  );
};
