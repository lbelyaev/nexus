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
}): GatewayServer => {
  const { port, host, token, router } = deps;
  const log = createLogger("gateway.server");

  const httpServer = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404);
      res.end();
    },
  );

  const wss = new WebSocketServer({ noServer: true });

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
    const emit = (event: GatewayEvent) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    };

    log.info("ws_connected", { connectionId });

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
      router.handleMessage(msg, emit);
    });

    ws.on("close", () => {
      log.info("ws_disconnected", { connectionId });
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
