import WebSocket from "ws";
import type { ClientMessage, GatewayEvent } from "@nexus/types";
import { isGatewayEvent } from "@nexus/types";

export interface GatewayClient {
  connect: () => Promise<void>;
  close: () => void;
  send: (message: ClientMessage) => void;
  onEvent: (handler: (event: GatewayEvent) => void) => void;
  onOpen: (handler: () => void) => void;
  onClose: (handler: () => void) => void;
  onError: (handler: (error: Error) => void) => void;
  isOpen: () => boolean;
}

const buildWsUrl = (url: string, token: string): string =>
  `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

export const createGatewayClient = (url: string, token: string): GatewayClient => {
  const wsUrl = buildWsUrl(url, token);
  let ws: WebSocket | null = null;
  let eventHandler: ((event: GatewayEvent) => void) | undefined;
  let openHandler: (() => void) | undefined;
  let closeHandler: (() => void) | undefined;
  let errorHandler: ((error: Error) => void) | undefined;

  const connect = (): Promise<void> => new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    ws = socket;

    socket.on("open", () => {
      openHandler?.();
      resolve();
    });

    socket.on("message", (data) => {
      const raw = typeof data === "string" ? data : data.toString("utf8");
      try {
        const parsed = JSON.parse(raw);
        if (isGatewayEvent(parsed)) {
          eventHandler?.(parsed);
        }
      } catch {
        // Ignore malformed frames from server.
      }
    });

    socket.on("close", () => {
      if (ws === socket) {
        ws = null;
      }
      closeHandler?.();
    });

    socket.on("error", (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      errorHandler?.(err);
      reject(err);
    });
  });

  const send = (message: ClientMessage): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway websocket is not connected");
    }
    ws.send(JSON.stringify(message));
  };

  return {
    connect,
    close: () => {
      ws?.close();
      ws = null;
    },
    send,
    onEvent: (handler) => {
      eventHandler = handler;
    },
    onOpen: (handler) => {
      openHandler = handler;
    },
    onClose: (handler) => {
      closeHandler = handler;
    },
    onError: (handler) => {
      errorHandler = handler;
    },
    isOpen: () => ws?.readyState === WebSocket.OPEN,
  };
};
