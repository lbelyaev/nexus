import type { GatewayEvent, JsonRpcNotification } from "@nexus/types";
import type { RpcClient } from "./rpc.js";

export type AcpEventHandler = (event: GatewayEvent) => void;

export interface AcpSession {
  id: string;
  acpSessionId: string;
  prompt: (text: string) => Promise<unknown>;
  respondToPermission: (requestId: string, optionId: string) => void;
  cancel: () => void;
  onEvent: (handler: AcpEventHandler) => void;
}

// Real ACP session/update notification shape
// { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "..." } } }
export interface AcpSessionUpdate {
  sessionUpdate: string;
  content?: AcpContentBlock | AcpContentBlock[];
  toolCallId?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  kind?: string;
}

export interface AcpContentBlock {
  type: string;
  text?: string;
}

export interface AcpSessionNotificationParams {
  sessionId: string;
  update: AcpSessionUpdate;
}

// Real ACP session/request_permission request shape (this is a JSON-RPC request, not notification)
export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title: string;
    status?: string;
    kind?: string;
    rawInput?: unknown;
  };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

const extractText = (content?: AcpContentBlock | AcpContentBlock[]): string => {
  if (!content) return "";
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("");
  }
  return content.type === "text" && content.text ? content.text : "";
};

export const translateNotification = (
  notification: JsonRpcNotification,
  gatewaySessionId: string,
  acpSessionId: string,
): GatewayEvent | null => {
  if (notification.method !== "session/update") return null;

  const p = notification.params as AcpSessionNotificationParams | undefined;
  if (!p || p.sessionId !== acpSessionId) return null;

  const update = p.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return {
        type: "text_delta",
        sessionId: gatewaySessionId,
        delta: extractText(update.content),
      };
    case "tool_call":
      return {
        type: "tool_start",
        sessionId: gatewaySessionId,
        tool: update.title ?? "unknown",
        params: update.rawInput ?? null,
      };
    case "tool_call_update":
      if (update.status === "completed" || update.status === "failed") {
        return {
          type: "tool_end",
          sessionId: gatewaySessionId,
          tool: update.title ?? "unknown",
          result: update.rawOutput as string | undefined,
        };
      }
      return null;
    default:
      return null;
  }
};

export const createAcpSession = (
  rpc: RpcClient,
  acpSessionId: string,
  gatewaySessionId: string,
): AcpSession => {
  let eventHandler: AcpEventHandler | undefined;

  // Pending permission requests from the agent (request_id → resolver)
  const pendingPermissions = new Map<
    string,
    { resolve: (result: unknown) => void }
  >();

  rpc.onNotification((notification: JsonRpcNotification) => {
    if (!eventHandler) return;
    const event = translateNotification(notification, gatewaySessionId, acpSessionId);
    if (event) eventHandler(event);
  });

  // Handle incoming requests from the agent (permission requests)
  rpc.onRequest(async (method: string, params: unknown) => {
    if (method === "session/request_permission") {
      const p = params as AcpRequestPermissionParams;
      if (p.sessionId !== acpSessionId) {
        throw new Error(`Unknown session: ${p.sessionId}`);
      }

      // Emit approval_request to the gateway client
      if (eventHandler) {
        const requestId = p.toolCall.toolCallId;
        eventHandler({
          type: "approval_request",
          sessionId: gatewaySessionId,
          requestId,
          tool: p.toolCall.title,
          description: p.toolCall.rawInput
            ? JSON.stringify(p.toolCall.rawInput)
            : p.toolCall.title,
        });

        // Wait for the user response via respondToPermission
        return new Promise((resolve) => {
          pendingPermissions.set(requestId, { resolve });
        });
      }

      // No handler — auto-reject
      return { outcome: { outcome: "cancelled" } };
    }

    throw new Error(`Unhandled method: ${method}`);
  });

  const prompt = (text: string): Promise<unknown> =>
    rpc.sendRequest("session/prompt", {
      sessionId: acpSessionId,
      prompt: [{ type: "text", text }],
    });

  const respondToPermission = (requestId: string, optionId: string): void => {
    const pending = pendingPermissions.get(requestId);
    if (pending) {
      pendingPermissions.delete(requestId);
      pending.resolve({ outcome: { outcome: "selected", optionId } });
    }
  };

  const cancel = (): void => {
    rpc.sendNotification("session/cancel", { sessionId: acpSessionId });
    // Cancel all pending permission requests
    for (const [id, entry] of pendingPermissions) {
      entry.resolve({ outcome: { outcome: "cancelled" } });
      pendingPermissions.delete(id);
    }
  };

  const onEvent = (handler: AcpEventHandler): void => {
    eventHandler = handler;
  };

  return {
    id: gatewaySessionId,
    acpSessionId,
    prompt,
    respondToPermission,
    cancel,
    onEvent,
  };
};
