import { Readable, Writable } from "node:stream";
import type { JsonRpcNotification, JsonRpcRequest } from "@nexus/types";
import { isJsonRpcResponse, isJsonRpcNotification, isJsonRpcRequest } from "@nexus/types";
import { parseNdjsonStream } from "./stream.js";

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

export interface RpcClient {
  sendRequest: (method: string, params?: unknown) => Promise<unknown>;
  sendNotification: (method: string, params?: unknown) => void;
  sendResponse: (id: number | string, result: unknown) => void;
  sendErrorResponse: (id: number | string, code: number, message: string) => void;
  onNotification: (handler: (notification: JsonRpcNotification) => void) => void;
  onRequest: (handler: RequestHandler) => void;
  destroy: () => void;
}

export const createRpcClient = (
  input: Readable,
  output: Writable,
  options?: { timeout?: number },
): RpcClient => {
  const timeout = options?.timeout ?? 30_000;
  let nextId = 1;

  const pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  let notificationHandler: ((notification: JsonRpcNotification) => void) | undefined;
  let requestHandler: RequestHandler | undefined;

  const handleMessage = (msg: unknown): void => {
    if (isJsonRpcRequest(msg)) {
      const req = msg as JsonRpcRequest;
      if (requestHandler) {
        requestHandler(req.method, req.params).then(
          (result) => sendResponse(req.id, result),
          (err: unknown) => sendErrorResponse(req.id, -32000, err instanceof Error ? err.message : "Unknown error"),
        );
      } else {
        sendErrorResponse(req.id, -32601, `Method not found: ${req.method}`);
      }
      return;
    }

    if (isJsonRpcNotification(msg)) {
      notificationHandler?.(msg);
      return;
    }

    if (isJsonRpcResponse(msg)) {
      const entry = pending.get(msg.id as number | string);
      if (!entry) return;
      pending.delete(msg.id as number | string);
      clearTimeout(entry.timer);

      if (msg.error) {
        entry.reject(new Error(msg.error.message));
      } else {
        entry.resolve(msg.result);
      }
    }
  };

  parseNdjsonStream(input, handleMessage, () => {});

  const sendRequest = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    const request: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) request.params = params;

    output.write(JSON.stringify(request) + "\n");

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC request "${method}" (id=${id}) timed out after ${timeout}ms`));
      }, timeout);

      pending.set(id, { resolve, reject, timer });
    });
  };

  const sendNotification = (method: string, params?: unknown): void => {
    const notification: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) notification.params = params;
    output.write(JSON.stringify(notification) + "\n");
  };

  const sendResponse = (id: number | string, result: unknown): void => {
    output.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  };

  const sendErrorResponse = (id: number | string, code: number, message: string): void => {
    output.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  };

  const onNotification = (handler: (notification: JsonRpcNotification) => void): void => {
    notificationHandler = handler;
  };

  const onRequest = (handler: RequestHandler): void => {
    requestHandler = handler;
  };

  const destroy = (): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
    }
    pending.clear();
  };

  return { sendRequest, sendNotification, sendResponse, sendErrorResponse, onNotification, onRequest, destroy };
};
