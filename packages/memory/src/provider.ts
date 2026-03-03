import type { StateStore } from "@nexus/state";
import { estimateTokens, type MemoryItem, type MemoryItemKind, type TranscriptMessage } from "@nexus/types";
import type {
  MemoryClearInput,
  MemoryContextInput,
  MemoryContextOutput,
  MemoryProvider,
  MemoryRecentInput,
  MemorySearchInput,
  MemoryStatsInput,
  MemoryStatsOutput,
  MemoryTurnInput,
  NormalizedMemoryConfig,
  SqliteMemoryProviderConfig,
} from "./types.js";

const DEFAULT_CONFIG: NormalizedMemoryConfig = {
  contextBudgetTokens: 1200,
  hotMessageCount: 8,
  warmSummaryCount: 4,
  coldFactCount: 8,
  workspaceSummaryCount: 3,
  workspaceFactCount: 8,
  maxFactsPerTurn: 6,
  maxFactLength: 240,
  summaryWindowMessages: 10,
};

const normalizeConfig = (config?: SqliteMemoryProviderConfig): NormalizedMemoryConfig => ({
  contextBudgetTokens: config?.contextBudgetTokens ?? DEFAULT_CONFIG.contextBudgetTokens,
  hotMessageCount: config?.hotMessageCount ?? DEFAULT_CONFIG.hotMessageCount,
  warmSummaryCount: config?.warmSummaryCount ?? DEFAULT_CONFIG.warmSummaryCount,
  coldFactCount: config?.coldFactCount ?? DEFAULT_CONFIG.coldFactCount,
  workspaceSummaryCount: config?.workspaceSummaryCount ?? DEFAULT_CONFIG.workspaceSummaryCount,
  workspaceFactCount: config?.workspaceFactCount ?? DEFAULT_CONFIG.workspaceFactCount,
  maxFactsPerTurn: config?.maxFactsPerTurn ?? DEFAULT_CONFIG.maxFactsPerTurn,
  maxFactLength: config?.maxFactLength ?? DEFAULT_CONFIG.maxFactLength,
  summaryWindowMessages: config?.summaryWindowMessages ?? DEFAULT_CONFIG.summaryWindowMessages,
});

const tokenize = (text: string): string[] => {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  return [...new Set(cleaned)];
};

const extractFactCandidates = (
  text: string,
  config: NormalizedMemoryConfig,
): string[] => {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 20 && entry.length <= config.maxFactLength);

  if (sentences.length === 0) return [];

  // Prefer statement-like sentences likely to be useful memory.
  const scored = sentences.map((sentence) => {
    const lower = sentence.toLowerCase();
    const hasAssertion = /\b(is|are|has|have|needs|wants|prefers|uses|works|supports)\b/.test(lower);
    const hasEntityToken = /\b[a-z][a-z0-9_-]{2,}\b/.test(lower);
    const score = (hasAssertion ? 2 : 0) + (hasEntityToken ? 1 : 0) + Math.min(sentence.length / 80, 2);
    return { sentence, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, config.maxFactsPerTurn)
    .map((entry) => entry.sentence);
};

const shortText = (text: string, max = 160): string => (
  text.length <= max ? text : `${text.slice(0, max - 3)}...`
);

const summarizeMessages = (messages: TranscriptMessage[]): string => {
  if (messages.length === 0) return "";
  const lines = messages.map((message) => {
    const role = message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : "user";
    return `${role}: ${shortText(message.content, 180)}`;
  });
  return lines.join("\n");
};

const memoryScore = (item: MemoryItem, queryTokens: Set<string>): number => {
  const keywordOverlap = item.keywords.filter((keyword) => queryTokens.has(keyword)).length;
  const recency = Date.parse(item.createdAt);
  const recencyScore = Number.isFinite(recency) ? recency / 1_000_000_000_000 : 0;
  return (keywordOverlap * 3) + item.confidence + recencyScore;
};

const includeByBudget = <T extends { tokenEstimate: number }>(
  entries: T[],
  remainingBudget: { value: number },
): T[] => {
  const included: T[] = [];
  for (const entry of entries) {
    if (entry.tokenEstimate <= remainingBudget.value) {
      included.push(entry);
      remainingBudget.value -= entry.tokenEstimate;
    }
  }
  return included;
};

const dedupeMemoryItems = (items: MemoryItem[]): MemoryItem[] => {
  const seen = new Set<number>();
  const result: MemoryItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
};

const renderContext = (
  hot: TranscriptMessage[],
  warm: MemoryItem[],
  cold: MemoryItem[],
): string => {
  if (hot.length === 0 && warm.length === 0 && cold.length === 0) {
    return "";
  }

  const lines: string[] = ["# Memory Context"];
  if (hot.length > 0) {
    lines.push("## Recent Transcript");
    for (const message of hot) {
      lines.push(`- ${message.role}: ${shortText(message.content, 220)}`);
    }
  }
  if (warm.length > 0) {
    lines.push("## Session Summaries");
    for (const item of warm) {
      lines.push(`- ${shortText(item.content, 240)}`);
    }
  }
  if (cold.length > 0) {
    lines.push("## Relevant Facts");
    for (const item of cold) {
      lines.push(`- ${shortText(item.content, 220)} (confidence=${item.confidence.toFixed(2)})`);
    }
  }
  lines.push("# End Memory Context");
  return lines.join("\n");
};

export const createSqliteMemoryProvider = (
  stateStore: StateStore,
  config?: SqliteMemoryProviderConfig,
): MemoryProvider => {
  const cfg = normalizeConfig(config);

  const getStats = (input: MemoryStatsInput): MemoryStatsOutput => {
    const scope = input.scope ?? "session";
    const memoryItems = scope === "workspace"
      ? stateStore.getWorkspaceMemoryItems(input.workspaceId)
      : stateStore.getMemoryItems(input.sessionId);
    const facts = memoryItems.filter((item) => item.kind === "fact").length;
    const summaries = memoryItems.filter((item) => item.kind === "summary").length;
    const memoryTokens = memoryItems.reduce((sum, item) => sum + item.tokenEstimate, 0);
    const transcriptMessages = scope === "workspace"
      ? stateStore.countWorkspaceMessages(input.workspaceId)
      : stateStore.getTranscript(input.sessionId).length;
    const transcriptTokens = scope === "workspace"
      ? stateStore.getWorkspaceTokenEstimate(input.workspaceId)
      : stateStore.getSessionTokenEstimate(input.sessionId);
    return {
      facts,
      summaries,
      total: memoryItems.length,
      transcriptMessages,
      memoryTokens,
      transcriptTokens,
    };
  };

  const getRecent = (input: MemoryRecentInput): MemoryItem[] => {
    const scope = input.scope ?? "session";
    const limit = input.limit ?? 10;
    const kinds = input.kinds;
    const all = scope === "workspace"
      ? stateStore.getWorkspaceMemoryItems(input.workspaceId, {
          newestFirst: true,
          limit: Math.max(limit * 3, limit),
        })
      : stateStore.getMemoryItems(input.sessionId, {
          newestFirst: true,
          limit: Math.max(limit * 3, limit),
        });
    const filtered = kinds && kinds.length > 0
      ? all.filter((item) => kinds.includes(item.kind))
      : all;
    return filtered.slice(0, limit);
  };

  const search = (input: MemorySearchInput): MemoryItem[] => {
    const scope = input.scope ?? "session";
    const limit = input.limit ?? cfg.coldFactCount;
    const kinds = input.kinds ?? (["fact", "summary"] satisfies MemoryItemKind[]);
    const queryTokens = new Set(tokenize(input.query));
    const queryTerms = queryTokens.size > 0 ? [...queryTokens] : [input.query.trim()];
    const candidates = new Map<number, MemoryItem>();

    for (const term of queryTerms) {
      if (!term) continue;
      const rows = scope === "workspace"
        ? stateStore.searchWorkspaceMemory(input.workspaceId, term, {
            limit: Math.max(limit * 3, limit),
            kinds,
          })
        : stateStore.searchMemory(input.sessionId, term, {
            limit: Math.max(limit * 3, limit),
            kinds,
          });
      for (const row of rows) {
        candidates.set(row.id, row);
      }
    }

    if (candidates.size === 0) return [];

    const raw = [...candidates.values()];
    const ranked = [...raw]
      .sort((a, b) => memoryScore(b, queryTokens) - memoryScore(a, queryTokens))
      .slice(0, limit);

    const now = new Date().toISOString();
    for (const item of ranked) {
      stateStore.touchMemoryItem(item.id, now);
    }

    return ranked;
  };

  const getContext = (input: MemoryContextInput): MemoryContextOutput => {
    const scope = input.scope ?? "hybrid";
    const budgetTokens = input.budgetTokens ?? cfg.contextBudgetTokens;
    const transcript = stateStore.getTranscript(input.sessionId);
    const hotPool = transcript.slice(-cfg.hotMessageCount);
    const sessionWarmPool = stateStore.getMemoryItems(input.sessionId, {
      kind: "summary",
      newestFirst: true,
      limit: cfg.warmSummaryCount,
    });
    const workspaceWarmPool = stateStore.getWorkspaceMemoryItems(input.workspaceId, {
      kind: "summary",
      newestFirst: true,
      excludeSessionId: input.sessionId,
      limit: cfg.workspaceSummaryCount,
    });
    const sessionColdPool = search({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      scope: "session",
      query: input.prompt,
      limit: cfg.coldFactCount,
      kinds: ["fact"],
    });
    const workspaceColdPool = search({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      scope: "workspace",
      query: input.prompt,
      limit: Math.max(cfg.workspaceFactCount * 3, cfg.workspaceFactCount),
      kinds: ["fact"],
    }).filter((item) => item.sessionId !== input.sessionId).slice(0, cfg.workspaceFactCount);

    const warmPool = scope === "workspace"
      ? workspaceWarmPool
      : scope === "session"
        ? sessionWarmPool
        : dedupeMemoryItems([...sessionWarmPool, ...workspaceWarmPool]);
    const coldPool = scope === "workspace"
      ? workspaceColdPool
      : scope === "session"
        ? sessionColdPool
        : dedupeMemoryItems([...sessionColdPool, ...workspaceColdPool]);

    const remaining = { value: budgetTokens };
    const hot = includeByBudget(hotPool, remaining);
    const warm = includeByBudget(warmPool, remaining);
    const cold = includeByBudget(coldPool, remaining);
    const totalTokens = budgetTokens - remaining.value;

    return {
      sessionId: input.sessionId,
      budgetTokens,
      totalTokens,
      hot,
      warm,
      cold,
      rendered: renderContext(hot, warm, cold),
    };
  };

  const recordTurn = (input: MemoryTurnInput): void => {
    const timestamp = input.timestamp ?? new Date().toISOString();
    const userFacts = extractFactCandidates(input.userText, cfg);
    const assistantFacts = input.assistantText
      ? extractFactCandidates(input.assistantText, cfg)
      : [];

    for (const fact of userFacts) {
      stateStore.appendMemoryItem({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        kind: "fact",
        content: fact,
        source: "user_prompt",
        confidence: 0.55,
        keywords: tokenize(fact),
        createdAt: timestamp,
        tokenEstimate: estimateTokens(fact),
      });
    }

    for (const fact of assistantFacts) {
      stateStore.appendMemoryItem({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        kind: "fact",
        content: fact,
        source: "assistant_reply",
        confidence: 0.7,
        keywords: tokenize(fact),
        createdAt: timestamp,
        tokenEstimate: estimateTokens(fact),
      });
    }

    const transcript = stateStore.getTranscript(input.sessionId);
    const summaryScope = transcript.slice(-cfg.summaryWindowMessages);
    const summary = summarizeMessages(summaryScope);
    if (!summary) return;

    const latestSummary = stateStore.getMemoryItems(input.sessionId, {
      kind: "summary",
      newestFirst: true,
      limit: 1,
    })[0];
    if (latestSummary && latestSummary.content === summary) {
      return;
    }

    stateStore.appendMemoryItem({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      kind: "summary",
      content: summary,
      source: "turn_summary",
      confidence: 0.85,
      keywords: tokenize(summary),
      createdAt: timestamp,
      tokenEstimate: estimateTokens(summary),
    });
  };

  const clear = (input: MemoryClearInput): number => {
    const scope = input.scope ?? "session";
    const current = scope === "workspace"
      ? stateStore.getWorkspaceMemoryItems(input.workspaceId)
      : stateStore.getMemoryItems(input.sessionId);
    if (scope === "workspace") {
      stateStore.deleteWorkspaceMemory(input.workspaceId);
    } else {
      stateStore.deleteMemory(input.sessionId);
    }
    return current.length;
  };

  return {
    id: "sqlite-memory",
    recordTurn,
    getStats,
    getRecent,
    search,
    getContext,
    clear,
  };
};

export type { MemoryProvider } from "./types.js";
