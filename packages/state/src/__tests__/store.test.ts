import { describe, it, expect } from "vitest";
import { createStateStore } from "../store.js";

describe("createStateStore", () => {
  it("with :memory: creates a working store", () => {
    const store = createStateStore(":memory:");
    expect(store).toBeDefined();
    expect(typeof store.createSession).toBe("function");
    expect(typeof store.getSession).toBe("function");
    expect(typeof store.close).toBe("function");
    store.close();
  });

  it("the returned object exposes both session and audit operations", () => {
    const store = createStateStore(":memory:");

    expect(typeof store.createSession).toBe("function");
    expect(typeof store.getSession).toBe("function");
    expect(typeof store.listSessions).toBe("function");
    expect(typeof store.updateSession).toBe("function");
    expect(typeof store.logEvent).toBe("function");
    expect(typeof store.getEvents).toBe("function");
    expect(typeof store.appendMessage).toBe("function");
    expect(typeof store.getTranscript).toBe("function");
    expect(typeof store.appendMemoryItem).toBe("function");
    expect(typeof store.getMemoryItems).toBe("function");
    expect(typeof store.searchMemory).toBe("function");
    expect(typeof store.createExecution).toBe("function");
    expect(typeof store.getExecution).toBe("function");
    expect(typeof store.listExecutions).toBe("function");
    expect(typeof store.transitionExecutionState).toBe("function");
    expect(typeof store.upsertChannelBinding).toBe("function");
    expect(typeof store.getChannelBinding).toBe("function");
    expect(typeof store.deleteChannelBinding).toBe("function");
    expect(typeof store.close).toBe("function");

    store.close();
  });

  it("session creation followed by audit writes followed by queries is consistent", () => {
    const store = createStateStore(":memory:");

    store.createSession({
      id: "sess-1",
      workspaceId: "default",
      principalType: "user",
      principalId: "user:local",
      source: "interactive",
      runtimeId: "rt-1",
      acpSessionId: "acp-1",
      status: "active",
      createdAt: "2025-01-01T00:00:00Z",
      lastActivityAt: "2025-01-01T00:00:00Z",
      tokenUsage: { input: 0, output: 0 },
      model: "claude-opus-4-20250514",
    });

    store.logEvent({
      sessionId: "sess-1",
      timestamp: "2025-01-01T00:01:00Z",
      type: "tool_call",
      tool: "Read",
      detail: "Read a file",
    });

    const session = store.getSession("sess-1");
    expect(session).not.toBeNull();
    expect(session?.id).toBe("sess-1");

    const events = store.getEvents("sess-1");
    expect(events).toHaveLength(1);
    expect(events[0].detail).toBe("Read a file");

    store.close();
  });
});
