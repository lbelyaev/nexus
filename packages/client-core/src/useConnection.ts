import { useState, useEffect, useCallback, useRef } from "react";
import type { ClientMessage, GatewayEvent } from "@nexus/types";
import { isGatewayEvent } from "@nexus/types";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface UseConnectionOptions {
  url: string;
  token: string;
  onEvent?: (event: GatewayEvent) => void;
}

export interface UseConnectionResult {
  status: ConnectionStatus;
  sendMessage: (msg: ClientMessage) => void;
  disconnect: () => void;
}

export const useConnection = (
  options: UseConnectionOptions,
): UseConnectionResult => {
  const { url, token, onEvent } = options;
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const decoder = new TextDecoder();
    const dispatchRaw = (raw: string): void => {
      try {
        const data = JSON.parse(raw);
        if (isGatewayEvent(data) && onEventRef.current) {
          onEventRef.current(data);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    const wsUrl = `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setStatus("connecting");

    ws.onopen = () => {
      setStatus("connected");
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        dispatchRaw(event.data);
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        dispatchRaw(decoder.decode(new Uint8Array(event.data)));
        return;
      }

      if (ArrayBuffer.isView(event.data)) {
        dispatchRaw(decoder.decode(event.data));
        return;
      }

      if (typeof Blob !== "undefined" && event.data instanceof Blob) {
        event.data
          .text()
          .then((text) => dispatchRaw(text))
          .catch(() => {});
        return;
      }

      // Some runtimes expose blob-like objects without instanceof Blob support.
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        "text" in event.data &&
        typeof (event.data as { text: unknown }).text === "function"
      ) {
        (
          event.data as unknown as { text: () => Promise<string> }
        )
          .text()
          .then((text) => dispatchRaw(text))
          .catch(() => {});
      }
    };

    ws.onerror = () => {
      setStatus("error");
    };

    ws.onclose = () => {
      setStatus("disconnected");
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [url, token]);

  const sendMessage = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const disconnect = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      ws.close();
      wsRef.current = null;
    }
  }, []);

  return { status, sendMessage, disconnect };
};
