import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseAdapter } from "../database.js";
import { initDatabase } from "../migrations.js";
import { createChannelBindingStore } from "../channelBindings.js";

describe("createChannelBindingStore", () => {
  let db: DatabaseAdapter;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initDatabase(db);
  });

  it("upserts and reads channel binding records", () => {
    const store = createChannelBindingStore(db);
    store.upsertChannelBinding({
      adapterId: "telegram",
      conversationId: "chat-1",
      sessionId: "gw-session-1",
      principalType: "user",
      principalId: "user:telegram:42",
      runtimeId: "claude",
      model: "sonnet",
      workspaceId: "default",
      typingIndicator: true,
      streamingMode: "off",
      steeringMode: "on",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const binding = store.getChannelBinding("telegram", "chat-1");
    expect(binding).toEqual({
      adapterId: "telegram",
      conversationId: "chat-1",
      sessionId: "gw-session-1",
      principalType: "user",
      principalId: "user:telegram:42",
      runtimeId: "claude",
      model: "sonnet",
      workspaceId: "default",
      typingIndicator: true,
      streamingMode: "off",
      steeringMode: "on",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("updates existing binding on upsert conflict", () => {
    const store = createChannelBindingStore(db);
    store.upsertChannelBinding({
      adapterId: "telegram",
      conversationId: "chat-1",
      sessionId: "gw-session-1",
      principalType: "user",
      principalId: "user:telegram:42",
      typingIndicator: true,
      streamingMode: "off",
      steeringMode: "off",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    store.upsertChannelBinding({
      adapterId: "telegram",
      conversationId: "chat-1",
      sessionId: "gw-session-2",
      principalType: "service_account",
      principalId: "service_account:telegram:bot",
      runtimeId: "codex",
      model: "gpt-5",
      workspaceId: "research",
      typingIndicator: false,
      streamingMode: "edit",
      steeringMode: "on",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:10:00Z",
    });

    expect(store.getChannelBinding("telegram", "chat-1")).toEqual({
      adapterId: "telegram",
      conversationId: "chat-1",
      sessionId: "gw-session-2",
      principalType: "service_account",
      principalId: "service_account:telegram:bot",
      runtimeId: "codex",
      model: "gpt-5",
      workspaceId: "research",
      typingIndicator: false,
      streamingMode: "edit",
      steeringMode: "on",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:10:00Z",
    });
  });

  it("deletes bindings", () => {
    const store = createChannelBindingStore(db);
    store.upsertChannelBinding({
      adapterId: "telegram",
      conversationId: "chat-1",
      sessionId: "gw-session-1",
      principalType: "user",
      principalId: "user:telegram:42",
      typingIndicator: true,
      streamingMode: "off",
      steeringMode: "off",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    store.deleteChannelBinding("telegram", "chat-1");
    expect(store.getChannelBinding("telegram", "chat-1")).toBeNull();
  });
});
