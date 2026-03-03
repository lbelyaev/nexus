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
  reconnect?: {
    enabled?: boolean;
    initialDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
  };
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
  const reconnectEnabled = options.reconnect?.enabled ?? true;
  const reconnectInitialDelayMs = options.reconnect?.initialDelayMs ?? 500;
  const reconnectMaxDelayMs = options.reconnect?.maxDelayMs ?? 10_000;
  const reconnectJitterRatio = options.reconnect?.jitterRatio ?? 0.2;
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const allowReconnectRef = useRef(true);
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

    const clearReconnectTimer = (): void => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = (): void => {
      if (!allowReconnectRef.current || !reconnectEnabled) return;
      clearReconnectTimer();
      const attempt = reconnectAttemptRef.current + 1;
      reconnectAttemptRef.current = attempt;
      const baseDelay = Math.min(
        reconnectMaxDelayMs,
        reconnectInitialDelayMs * (2 ** (attempt - 1)),
      );
      const jitterRange = Math.max(0, Math.floor(baseDelay * reconnectJitterRatio));
      const jitter = jitterRange > 0
        ? Math.floor(Math.random() * (jitterRange * 2 + 1)) - jitterRange
        : 0;
      const delayMs = Math.max(100, baseDelay + jitter);
      setStatus("connecting");
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delayMs);
    };

    const connect = (): void => {
      if (!allowReconnectRef.current) return;
      const wsUrl = `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      setStatus("connecting");

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
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
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        setStatus("disconnected");
        scheduleReconnect();
      };
    };

    allowReconnectRef.current = true;
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    connect();

    return () => {
      allowReconnectRef.current = false;
      clearReconnectTimer();
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [
    reconnectEnabled,
    reconnectInitialDelayMs,
    reconnectJitterRatio,
    reconnectMaxDelayMs,
    token,
    url,
  ]);

  const sendMessage = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const disconnect = useCallback(() => {
    allowReconnectRef.current = false;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.close();
    }
    setStatus("disconnected");
  }, []);

  return { status, sendMessage, disconnect };
};
