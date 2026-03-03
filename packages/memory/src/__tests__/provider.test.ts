import { describe, expect, it } from "vitest";
import { createStateStore } from "@nexus/state";
import { createSqliteMemoryProvider } from "../provider.js";

describe("createSqliteMemoryProvider", () => {
  it("records facts and summaries from a turn", () => {
    const store = createStateStore(":memory:");
    const provider = createSqliteMemoryProvider(store, {
      maxFactsPerTurn: 2,
      summaryWindowMessages: 4,
    });

    store.appendMessage({
      sessionId: "sess-1",
      role: "user",
      content: "I use Telegram for urgent alerts.",
      timestamp: "2026-01-01T00:00:00Z",
      tokenEstimate: 8,
    });
    store.appendMessage({
      sessionId: "sess-1",
      role: "assistant",
      content: "Understood. You use Telegram for urgent alerts and prefer concise updates.",
      timestamp: "2026-01-01T00:00:01Z",
      tokenEstimate: 14,
    });

    provider.recordTurn({
      workspaceId: "ws-1",
      sessionId: "sess-1",
      userText: "I use Telegram for urgent alerts.",
      assistantText: "You use Telegram for urgent alerts and prefer concise updates.",
      timestamp: "2026-01-01T00:00:02Z",
    });

    const facts = store.getMemoryItems("sess-1", { kind: "fact" });
    const summaries = store.getMemoryItems("sess-1", { kind: "summary" });

    expect(facts.length).toBeGreaterThan(0);
    expect(facts.some((item) => item.content.includes("Telegram"))).toBe(true);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].content).toContain("user:");
    store.close();
  });

  it("search returns relevant memory ranked by query overlap", () => {
    const store = createStateStore(":memory:");
    const provider = createSqliteMemoryProvider(store);

    store.appendMemoryItem({
      sessionId: "sess-1",
      kind: "fact",
      content: "Uses Telegram for urgent alerts",
      source: "manual",
      confidence: 0.8,
      keywords: ["telegram", "alerts"],
      createdAt: "2026-01-01T00:00:00Z",
      tokenEstimate: 6,
    });
    store.appendMemoryItem({
      sessionId: "sess-1",
      kind: "fact",
      content: "Uses Discord for community chatter",
      source: "manual",
      confidence: 0.8,
      keywords: ["discord", "community"],
      createdAt: "2026-01-01T00:00:01Z",
      tokenEstimate: 7,
    });

    const results = provider.search({
      workspaceId: "ws-1",
      sessionId: "sess-1",
      query: "telegram alerts",
      limit: 1,
      kinds: ["fact"],
    });

    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("Telegram");
    store.close();
  });

  it("builds budgeted context with hot, warm, cold sections", () => {
    const store = createStateStore(":memory:");
    const provider = createSqliteMemoryProvider(store, {
      hotMessageCount: 4,
      warmSummaryCount: 2,
      coldFactCount: 2,
      contextBudgetTokens: 80,
    });

    store.appendMessage({
      sessionId: "sess-1",
      role: "user",
      content: "We deploy every Friday.",
      timestamp: "2026-01-01T00:00:00Z",
      tokenEstimate: 5,
    });
    store.appendMessage({
      sessionId: "sess-1",
      role: "assistant",
      content: "Noted: deployment window is Friday.",
      timestamp: "2026-01-01T00:00:01Z",
      tokenEstimate: 7,
    });
    store.appendMemoryItem({
      sessionId: "sess-1",
      kind: "summary",
      content: "user: We deploy every Friday.\nassistant: deployment window is Friday.",
      source: "turn_summary",
      confidence: 0.9,
      keywords: ["deploy", "friday"],
      createdAt: "2026-01-01T00:00:02Z",
      tokenEstimate: 14,
    });
    store.appendMemoryItem({
      sessionId: "sess-1",
      kind: "fact",
      content: "Deployment day is Friday",
      source: "fact_extraction",
      confidence: 0.8,
      keywords: ["deployment", "friday"],
      createdAt: "2026-01-01T00:00:03Z",
      tokenEstimate: 6,
    });

    const context = provider.getContext({
      workspaceId: "ws-1",
      sessionId: "sess-1",
      prompt: "When do we deploy?",
      budgetTokens: 40,
    });

    expect(context.totalTokens).toBeLessThanOrEqual(40);
    expect(context.hot.length).toBeGreaterThan(0);
    expect(context.warm.length).toBeGreaterThan(0);
    expect(context.cold.length).toBeGreaterThan(0);
    expect(context.rendered).toContain("# Memory Context");
    expect(context.rendered).toContain("Recent Transcript");
    expect(context.rendered).toContain("Relevant Facts");
    store.close();
  });

  it("returns stats/recent and supports clear", () => {
    const store = createStateStore(":memory:");
    const provider = createSqliteMemoryProvider(store);

    store.appendMessage({
      sessionId: "sess-1",
      role: "user",
      content: "use telegram",
      timestamp: "2026-01-01T00:00:00Z",
      tokenEstimate: 3,
    });
    store.appendMemoryItem({
      sessionId: "sess-1",
      kind: "fact",
      content: "Uses Telegram for alerts",
      source: "manual",
      confidence: 0.8,
      keywords: ["telegram", "alerts"],
      createdAt: "2026-01-01T00:00:01Z",
      tokenEstimate: 6,
    });
    store.appendMemoryItem({
      sessionId: "sess-1",
      kind: "summary",
      content: "user prefers telegram",
      source: "manual",
      confidence: 0.9,
      keywords: ["telegram"],
      createdAt: "2026-01-01T00:00:02Z",
      tokenEstimate: 5,
    });

    const stats = provider.getStats({ workspaceId: "ws-1", sessionId: "sess-1" });
    expect(stats.total).toBe(2);
    expect(stats.facts).toBe(1);
    expect(stats.summaries).toBe(1);
    expect(stats.transcriptMessages).toBe(1);

    const recent = provider.getRecent({ workspaceId: "ws-1", sessionId: "sess-1", limit: 1 });
    expect(recent).toHaveLength(1);
    expect(recent[0].content).toContain("telegram");

    const deleted = provider.clear({ workspaceId: "ws-1", sessionId: "sess-1" });
    expect(deleted).toBe(2);
    expect(store.getMemoryItems("sess-1")).toHaveLength(0);
    store.close();
  });
});
