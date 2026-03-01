import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { parseClientMessage, type GatewayEvent } from "@nexus/types";
import { validateToken } from "./auth.js";
import type { Router } from "./router.js";

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
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (data: Buffer | string) => {
      const raw = typeof data === "string" ? data : data.toString();

      let msg;
      try {
        msg = parseClientMessage(raw);
      } catch {
        const errorEvent: GatewayEvent = {
          type: "error",
          sessionId: "",
          message: `Invalid message: ${raw.slice(0, 200)}`,
        };
        ws.send(JSON.stringify(errorEvent));
        return;
      }

      const emit = (event: GatewayEvent) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(event));
        }
      };
      router.handleMessage(msg, emit);
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
