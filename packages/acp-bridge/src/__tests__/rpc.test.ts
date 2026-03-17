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

  it("sendRequest can disable the default wall clock timeout", async () => {
    vi.useFakeTimers();
    const { childStdout, childStdin } = makeStreams();
    const rpc = createRpcClient(childStdout, childStdin, { timeout: 20 });

    const promise = rpc.sendRequest("test/no-timeout", undefined, { timeout: null });

    await vi.advanceTimersByTimeAsync(30);
    childStdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }) + "\n");

    await expect(promise).resolves.toBe("ok");

    rpc.destroy();
    vi.useRealTimers();
  });

  it("sendRequest can time out on inactivity and reset on related session activity", async () => {
    vi.useFakeTimers();
    const { childStdout, childStdin } = makeStreams();
    const rpc = createRpcClient(childStdout, childStdin, { timeout: 1_000 });

    const promise = rpc.sendRequest("session/prompt", { sessionId: "s1" }, {
      timeout: null,
      inactivityTimeout: 50,
      activityKey: "s1",
    });
    const rejection = promise.catch((error: unknown) => error);
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(30);
    childStdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "working" },
        },
      },
    }) + "\n");

    await vi.advanceTimersByTimeAsync(30);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(60);
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/timed out after 50ms of inactivity/i);

    rpc.destroy();
    vi.useRealTimers();
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

  it("multiple notification handlers all receive the same notification", async () => {
    const { childStdout, childStdin } = makeStreams();
    const rpc = createRpcClient(childStdout, childStdin, { timeout: 500 });

    const received1: unknown[] = [];
    const received2: unknown[] = [];
    rpc.onNotification((n) => received1.push(n));
    rpc.onNotification((n) => received2.push(n));

    childStdout.write(
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { x: 1 } }) + "\n",
    );

    await vi.waitFor(() => {
      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
    });

    expect(received1[0]).toEqual(received2[0]);

    rpc.destroy();
  });

  it("onNotification returns unsubscribe function", async () => {
    const { childStdout, childStdin } = makeStreams();
    const rpc = createRpcClient(childStdout, childStdin, { timeout: 500 });

    const received: unknown[] = [];
    const unsub = rpc.onNotification((n) => received.push(n));

    childStdout.write(
      JSON.stringify({ jsonrpc: "2.0", method: "test", params: {} }) + "\n",
    );

    await vi.waitFor(() => expect(received).toHaveLength(1));

    unsub();

    childStdout.write(
      JSON.stringify({ jsonrpc: "2.0", method: "test", params: {} }) + "\n",
    );

    // Give time for any handler to fire
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1); // still 1, unsubscribed

    rpc.destroy();
  });

  it("multiple request handlers — first to resolve wins", async () => {
    const { childStdout, childStdin } = makeStreams();
    const written = collectWritten(childStdin);
    const rpc = createRpcClient(childStdout, childStdin, { timeout: 500 });

    // Handler 1 only handles session "s1"
    rpc.onRequest(async (_method, params) => {
      const p = params as { sessionId: string };
      if (p.sessionId !== "s1") throw new Error("not mine");
      return { result: "handler1" };
    });

    // Handler 2 only handles session "s2"
    rpc.onRequest(async (_method, params) => {
      const p = params as { sessionId: string };
      if (p.sessionId !== "s2") throw new Error("not mine");
      return { result: "handler2" };
    });

    // Send request for s2 — should be handled by handler2
    childStdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "session/request_permission",
        params: { sessionId: "s2" },
      }) + "\n",
    );

    await vi.waitFor(() => expect(written.length).toBeGreaterThanOrEqual(1));

    const response = JSON.parse(written[0]!.trim());
    expect(response.result).toEqual({ result: "handler2" });

    rpc.destroy();
  });
});
