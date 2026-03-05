import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { parseClientMessage, type GatewayEvent } from "@nexus/types";
import { validateToken } from "./auth.js";
import type { Router } from "./router.js";
import { createLogger } from "./logger.js";

export interface GatewayServer {
  start: () => Promise<{ port: number }>;
  stop: () => Promise<void>;
}

export const createGatewayServer = (deps: {
  port: number;
  host: string;
  token: string;
  router: Router;
  healthProvider?: () => Record<string, unknown>;
  wsPingIntervalMs?: number;
  wsPongGraceMs?: number;
  wsBackpressureWarnBytes?: number;
  wsBackpressureTerminateBytes?: number;
  wsBufferedAmountProvider?: (ws: WebSocket) => number;
}): GatewayServer => {
  const {
    port,
    host,
    token,
    router,
    healthProvider,
    wsPingIntervalMs = 20_000,
    wsPongGraceMs = 10_000,
    wsBackpressureWarnBytes = 512_000,
    wsBackpressureTerminateBytes = 2_000_000,
    wsBufferedAmountProvider = (ws: WebSocket) => ws.bufferedAmount,
  } = deps;
  const log = createLogger("gateway.server");

  const httpServer = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          ...(healthProvider ? healthProvider() : {}),
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    },
  );

  const wss = new WebSocketServer({ noServer: true });
  const wsHeartbeatTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>();

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const providedToken = url.searchParams.get("token");

    if (!validateToken(providedToken, token)) {
      log.warn("ws_upgrade_rejected_invalid_token", {
        remoteAddress: req.socket.remoteAddress ?? null,
      });
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let backpressureWarned = false;
    let droppedBackpressureDeltas = 0;
    const emit = (event: GatewayEvent) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      const bufferedAmount = Math.max(0, Math.floor(wsBufferedAmountProvider(ws)));
      if (bufferedAmount >= wsBackpressureTerminateBytes) {
        log.warn("ws_backpressure_terminate", {
          connectionId,
          bufferedAmount,
          terminateBytes: wsBackpressureTerminateBytes,
          eventType: event.type,
        });
        ws.terminate();
        return;
      }

      const isDroppableDelta = event.type === "text_delta" || event.type === "thinking_delta";
      if (bufferedAmount >= wsBackpressureWarnBytes) {
        if (!backpressureWarned) {
          backpressureWarned = true;
          log.warn("ws_backpressure_high", {
            connectionId,
            bufferedAmount,
            warnBytes: wsBackpressureWarnBytes,
          });
        }
        if (isDroppableDelta) {
          droppedBackpressureDeltas += 1;
          if (droppedBackpressureDeltas === 1 || droppedBackpressureDeltas % 100 === 0) {
            log.warn("ws_backpressure_dropped_delta", {
              connectionId,
              droppedCount: droppedBackpressureDeltas,
              bufferedAmount,
              eventType: event.type,
            });
          }
          return;
        }
      } else if (backpressureWarned) {
        backpressureWarned = false;
        droppedBackpressureDeltas = 0;
        log.info("ws_backpressure_recovered", {
          connectionId,
          bufferedAmount,
        });
      }

      ws.send(JSON.stringify(event));
    };

    router.registerConnection(connectionId, emit);
    log.info("ws_connected", { connectionId });

    const schedulePongTimeout = (): void => {
      const existing = wsHeartbeatTimers.get(ws);
      if (existing) {
        clearTimeout(existing);
      }
      const timer = setTimeout(() => {
        log.warn("ws_pong_timeout_terminate", { connectionId });
        ws.terminate();
      }, wsPongGraceMs);
      wsHeartbeatTimers.set(ws, timer);
    };

    ws.on("pong", () => {
      const timer = wsHeartbeatTimers.get(ws);
      if (timer) {
        clearTimeout(timer);
        wsHeartbeatTimers.delete(ws);
      }
      log.debug("ws_pong_received", { connectionId });
    });

    ws.on("message", (data: Buffer | string) => {
      const raw = typeof data === "string" ? data : data.toString();
      log.debug("ws_message_received", {
        connectionId,
        preview: raw.slice(0, 200),
      });

      let msg;
      try {
        msg = parseClientMessage(raw);
      } catch (err) {
        log.warn("ws_message_parse_error", {
          connectionId,
          error: err instanceof Error ? err.message : String(err),
        });
        const errorEvent: GatewayEvent = {
          type: "error",
          sessionId: "",
          message: `Invalid message: ${raw.slice(0, 200)}`,
        };
        emit(errorEvent);
        return;
      }
      router.handleMessage(msg, emit, { connectionId });
    });

    ws.on("close", () => {
      const timer = wsHeartbeatTimers.get(ws);
      if (timer) {
        clearTimeout(timer);
        wsHeartbeatTimers.delete(ws);
      }
      router.unregisterConnection(connectionId, emit);
      log.info("ws_disconnected", { connectionId });
    });

    ws.on("error", (error) => {
      log.warn("ws_error", {
        connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    const pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      schedulePongTimeout();
      ws.ping();
      log.debug("ws_ping_sent", { connectionId });
    }, Math.max(1_000, wsPingIntervalMs));

    ws.on("close", () => {
      clearInterval(pingTimer);
    });
  });

  const start = (): Promise<{ port: number }> =>
    new Promise((resolve, reject) => {
      httpServer.on("error", reject);
      httpServer.listen(port, host, () => {
        const addr = httpServer.address();
        const assignedPort =
          typeof addr === "object" && addr !== null ? addr.port : port;
        resolve({ port: assignedPort });
      });
    });

  const stop = (): Promise<void> =>
    new Promise((resolve, reject) => {
      // Close all WebSocket connections
      for (const client of wss.clients) {
        client.close();
      }
      wss.close(() => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });

  return { start, stop };
};
