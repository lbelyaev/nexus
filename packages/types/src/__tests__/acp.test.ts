import { describe, it, expect } from "vitest";
import {
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcNotification,
  parseAcpLine,
} from "../acp.js";

describe("isJsonRpcRequest", () => {
  it("validates a well-formed request", () => {
    expect(isJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "initialize" })).toBe(true);
    expect(isJsonRpcRequest({ jsonrpc: "2.0", id: "abc", method: "session/new", params: {} })).toBe(true);
  });

  it("rejects messages without id", () => {
    expect(isJsonRpcRequest({ jsonrpc: "2.0", method: "session/update" })).toBe(false);
  });

  it("rejects messages without method", () => {
    expect(isJsonRpcRequest({ jsonrpc: "2.0", id: 1 })).toBe(false);
  });

  it("rejects wrong jsonrpc version", () => {
    expect(isJsonRpcRequest({ jsonrpc: "1.0", id: 1, method: "test" })).toBe(false);
  });
});

describe("isJsonRpcResponse", () => {
  it("validates a result response", () => {
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } })).toBe(true);
  });

  it("validates an error response", () => {
    expect(isJsonRpcResponse({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "Invalid request" },
    })).toBe(true);
  });

  it("validates a response with null id", () => {
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: null, error: { code: -1, message: "err" } })).toBe(true);
  });

  it("rejects messages with method (those are requests)", () => {
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, method: "foo", result: {} })).toBe(false);
  });
});

describe("isJsonRpcNotification", () => {
  it("validates a notification (method, no id)", () => {
    expect(isJsonRpcNotification({ jsonrpc: "2.0", method: "session/update", params: {} })).toBe(true);
  });

  it("rejects messages with id", () => {
    expect(isJsonRpcNotification({ jsonrpc: "2.0", id: 1, method: "session/update" })).toBe(false);
  });
});

describe("parseAcpLine", () => {
  it("parses a request line", () => {
    const msg = parseAcpLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(msg).toHaveProperty("method", "initialize");
  });

  it("parses a response line", () => {
    const msg = parseAcpLine('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(msg).toHaveProperty("result");
  });

  it("parses a notification line", () => {
    const msg = parseAcpLine('{"jsonrpc":"2.0","method":"session/update","params":{}}');
    expect(msg).toHaveProperty("method", "session/update");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseAcpLine("not json")).toThrow();
  });

  it("throws on valid JSON but not a JSON-RPC message", () => {
    expect(() => parseAcpLine('{"foo":"bar"}')).toThrow("Invalid ACP message");
  });
});
