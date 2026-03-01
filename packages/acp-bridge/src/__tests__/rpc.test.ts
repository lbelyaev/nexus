import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createRpcClient } from "../rpc.js";

const makeStreams = () => {
  const childStdout = new PassThrough(); // we read from this (input)
  const childStdin = new PassThrough(); // we write to this (output)
  return { childStdout, childStdin };
};

const collectWritten = (stream: PassThrough): string[] => {
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  return chunks;
};

describe("createRpcClient", () => {
  it("sendRequest writes well-formed JSON-RPC with auto-incrementing IDs", async () => {
    const { childStdout, childStdin } = makeStreams();
    const written = collectWritten(childStdin);
    const rpc = createRpcClient(childStdout, childStdin, { timeout: 500 });

    // Send two requests, respond to both
    const p1 = rpc.sendRequest("method1", { key: "val1" });
    const p2 = rpc.sendRequest("method2", { key: "val2" });

    // Parse what was written
    const parsed1 = JSON.parse(written[0]!.trim());
    const parsed2 = JSON.parse(written[1]!.trim());

    expect(parsed1).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "method1",
      params: { key: "val1" },
    });
    expect(parsed2).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "method2",
      params: { key: "val2" },
    });

    // Respond to resolve promises
    childStdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok1" }) + "\n");
    childStdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "ok2" }) + "\n");

    await expect(p1).resolves.toBe("ok1");
    await expect(p2).resolves.toBe("ok2");

    rpc.destroy();
  });

  it("sendRequest returns a promise that resolves when matching response arrives", async () => {
    const { childStdout, childStdin } = makeStreams();
    const rpc = createRpcClient(childStdout, childStdin, { timeout: 500 });

    const promise = rpc.sendRequest("test/method");

    // Simulate response
    childStdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { data: 42 } }) + "\n");

    const result = await promise;
    expect(result).toEqual({ data: 42 });

    rpc.destroy();
  });

  it("sendRequest rejects if response contains error field", async () => {
    const { childStdout, childStdin } = makeStreams();
    const rpc = createRpcClient(childStdout, childStdin, { timeout: 500 });

    const promise = rpc.sendRequest("test/fail");

    childStdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "Invalid Request" },
      }) + "\n",
    );

    await expect(promise).rejects.toThrow("Invalid Request");

    rpc.destroy();
  });

  it("sendRequest times out if no response arrives", async () => {
    const { childStdout, childStdin } = makeStreams();
    const rpc = createRpcClient(childStdout, childStdin, { timeout: 50 });

    const promise = rpc.sendRequest("test/timeout");

    await expect(promise).rejects.toThrow(/timed out/i);

    rpc.destroy();
  });

  it("sendNotification writes JSON-RPC notification without id", () => {
    const { childStdout, childStdin } = makeStreams();
    const written = collectWritten(childStdin);
    const rpc = createRpcClient(childStdout, childStdin);

    rpc.sendNotification("notify/something", { info: true });

    const parsed = JSON.parse(written[0]!.trim());
    expect(parsed).toEqual({
      jsonrpc: "2.0",
      method: "notify/something",
      params: { info: true },
    });
    expect(parsed).not.toHaveProperty("id");

    rpc.destroy();
  });

  it("concurrent requests with different IDs resolve independently", async () => {
    const { childStdout, childStdin } = makeStreams();
    const rpc = createRpcClient(childStdout, childStdin, { timeout: 500 });

    const p1 = rpc.sendRequest("a");
    const p2 = rpc.sendRequest("b");
    const p3 = rpc.sendRequest("c");

    // Respond out of order
    childStdout.write(JSON.stringify({ jsonrpc: "2.0", id: 3, result: "c-result" }) + "\n");
    childStdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "a-result" }) + "\n");
    childStdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "b-result" }) + "\n");

    await expect(p1).resolves.toBe("a-result");
    await expect(p2).resolves.toBe("b-result");
    await expect(p3).resolves.toBe("c-result");

    rpc.destroy();
  });

  it("incoming requests are dispatched to onRequest handler and response is sent", async () => {
    const { childStdout, childStdin } = makeStreams();
    const written = collectWritten(childStdin);
    const rpc = createRpcClient(childStdout, childStdin, { timeout: 500 });

    rpc.onRequest(async (method, params) => {
      if (method === "session/request_permission") {
        return { outcome: { outcome: "selected", optionId: "allow_once" } };
      }
      throw new Error(`Unknown method: ${method}`);
    });

    // Simulate an incoming request from the agent
    childStdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "session/request_permission",
        params: { sessionId: "s1", toolCall: {}, options: [] },
      }) + "\n",
    );

    // Wait for the response to be written
    await vi.waitFor(() => {
      expect(written.length).toBeGreaterThanOrEqual(1);
    });

    const response = JSON.parse(written[0]!.trim());
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: { outcome: { outcome: "selected", optionId: "allow_once" } },
    });

    rpc.destroy();
  });

  it("incoming requests send error response when handler throws", async () => {
    const { childStdout, childStdin } = makeStreams();
    const written = collectWritten(childStdin);
    const rpc = createRpcClient(childStdout, childStdin, { timeout: 500 });

    rpc.onRequest(async () => {
      throw new Error("Not implemented");
    });

    childStdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: 99, method: "unknown/method", params: {} }) + "\n",
    );

    await vi.waitFor(() => {
      expect(written.length).toBeGreaterThanOrEqual(1);
    });

    const response = JSON.parse(written[0]!.trim());
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(99);
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toBe("Not implemented");

    rpc.destroy();
  });

  it("incoming notifications routed to notification handler, not pending requests", async () => {
    const { childStdout, childStdin } = makeStreams();
    const rpc = createRpcClient(childStdout, childStdin, { timeout: 500 });

    const notifications: unknown[] = [];
    rpc.onNotification((n) => notifications.push(n));

    const promise = rpc.sendRequest("test/method");

    // Send a notification (no id) before the response
    childStdout.write(
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { status: "working" } }) + "\n",
    );

    // Then send the actual response
    childStdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "done" }) + "\n");

    await expect(promise).resolves.toBe("done");
    expect(notifications).toEqual([
      { jsonrpc: "2.0", method: "session/update", params: { status: "working" } },
    ]);

    rpc.destroy();
  });
});
