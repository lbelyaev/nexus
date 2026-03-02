import WebSocket, { type RawData } from "ws";
import { isGatewayEvent, type ClientMessage, type GatewayEvent } from "@nexus/types";

export interface NexusCliClientOptions {
  url: string;
  token: string;
  sessionId?: string;
}

export interface NexusCliClient {
  connect: () => Promise<void>;
  close: () => void;
  send: (msg: ClientMessage) => void;
  createSession: (runtimeId?: string, model?: string) => void;
  getSessionId: () => string | undefined;
  isOpen: () => boolean;
  onEvent: (handler: (event: GatewayEvent) => void) => void;
  onError: (handler: (error: Error) => void) => void;
  onClose: (handler: () => void) => void;
  onOpen: (handler: () => void) => void;
}

const buildWsUrl = (url: string, token: string): string =>
  `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

export const createNexusCliClient = (
  options: NexusCliClientOptions,
): NexusCliClient => {
  const wsUrl = buildWsUrl(options.url, options.token);
  let ws: WebSocket | null = null;
  let sessionId = options.sessionId;
  let eventHandler: ((event: GatewayEvent) => void) | undefined;
  let errorHandler: ((error: Error) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  let openHandler: (() => void) | undefined;

  const connect = (): Promise<void> =>
    new Promise((resolve, reject) => {
      ws = new WebSocket(wsUrl);

      ws.on("open", () => {
        if (openHandler) openHandler();
        resolve();
      });

      ws.on("message", (data: RawData) => {
        let raw: string;
        if (typeof data === "string") {
          raw = data;
        } else if (data instanceof Buffer) {
          raw = data.toString("utf-8");
        } else if (data instanceof ArrayBuffer) {
          raw = Buffer.from(new Uint8Array(data)).toString("utf-8");
        } else if (Array.isArray(data)) {
          raw = Buffer.concat(data).toString("utf-8");
        } else {
          return;
        }

        try {
          const parsed = JSON.parse(raw);
          if (!isGatewayEvent(parsed)) return;
          if (parsed.type === "session_created") {
            sessionId = parsed.sessionId;
          }
          if (eventHandler) eventHandler(parsed);
        } catch (error) {
          if (errorHandler && error instanceof Error) {
            errorHandler(error);
          }
        }
      });

      ws.on("error", (error: Error) => {
        if (errorHandler) errorHandler(error);
        reject(error);
      });

      ws.on("close", () => {
        if (closeHandler) closeHandler();
      });
    });

  const send = (msg: ClientMessage): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    ws.send(JSON.stringify(msg));
  };

  const createSession = (
    runtimeId?: string,
    model?: string,
  ): void => {
    send({ type: "session_new", runtimeId, model });
  };

  const close = (): void => {
    if (ws) {
      ws.close();
      ws = null;
    }
  };

  const getSessionId = (): string | undefined => sessionId;
  const isOpen = (): boolean => ws?.readyState === WebSocket.OPEN;
  const onEvent = (handler: (event: GatewayEvent) => void): void => {
    eventHandler = handler;
  };
  const onError = (handler: (error: Error) => void): void => {
    errorHandler = handler;
  };
  const onClose = (handler: () => void): void => {
    closeHandler = handler;
  };
  const onOpen = (handler: () => void): void => {
    openHandler = handler;
  };

  return {
    connect,
    close,
    send,
    createSession,
    getSessionId,
    isOpen,
    onEvent,
    onError,
    onClose,
    onOpen,
  };
};
