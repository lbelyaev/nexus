import type { StateStore } from "@nexus/state";
import { estimateTokens, type MemoryItem, type MemoryItemKind, type TranscriptMessage } from "@nexus/types";
import type {
  MemoryContextInput,
  MemoryContextOutput,
  MemoryProvider,
  MemorySearchInput,
  MemoryTurnInput,
  NormalizedMemoryConfig,
  SqliteMemoryProviderConfig,
} from "./types.js";

const DEFAULT_CONFIG: NormalizedMemoryConfig = {
  contextBudgetTokens: 1200,
  hotMessageCount: 8,
  warmSummaryCount: 4,
  coldFactCount: 8,
  maxFactsPerTurn: 6,
  maxFactLength: 240,
  summaryWindowMessages: 10,
};

const normalizeConfig = (config?: SqliteMemoryProviderConfig): NormalizedMemoryConfig => ({
  contextBudgetTokens: config?.contextBudgetTokens ?? DEFAULT_CONFIG.contextBudgetTokens,
  hotMessageCount: config?.hotMessageCount ?? DEFAULT_CONFIG.hotMessageCount,
  warmSummaryCount: config?.warmSummaryCount ?? DEFAULT_CONFIG.warmSummaryCount,
  coldFactCount: config?.coldFactCount ?? DEFAULT_CONFIG.coldFactCount,
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

  const search = (input: MemorySearchInput): MemoryItem[] => {
    const limit = input.limit ?? cfg.coldFactCount;
    const kinds = input.kinds ?? (["fact", "summary"] satisfies MemoryItemKind[]);
    const queryTokens = new Set(tokenize(input.query));
    const queryTerms = queryTokens.size > 0 ? [...queryTokens] : [input.query.trim()];
    const candidates = new Map<number, MemoryItem>();

    for (const term of queryTerms) {
      if (!term) continue;
      const rows = stateStore.searchMemory(input.sessionId, term, {
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
    const budgetTokens = input.budgetTokens ?? cfg.contextBudgetTokens;
    const transcript = stateStore.getTranscript(input.sessionId);
    const hotPool = transcript.slice(-cfg.hotMessageCount);
    const warmPool = stateStore.getMemoryItems(input.sessionId, {
      kind: "summary",
      newestFirst: true,
      limit: cfg.warmSummaryCount,
    });
    const coldPool = search({
      sessionId: input.sessionId,
      query: input.prompt,
      limit: cfg.coldFactCount,
      kinds: ["fact"],
    });

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

  return {
    id: "sqlite-memory",
    recordTurn,
    search,
    getContext,
  };
};

export type { MemoryProvider } from "./types.js";
