import type { MemoryItem, MemoryItemKind, TranscriptMessage } from "@nexus/types";

export type MemoryScope = "session" | "workspace" | "hybrid";

export interface MemoryTurnInput {
  workspaceId: string;
  sessionId: string;
  userText: string;
  assistantText?: string;
  timestamp?: string;
}

export interface MemorySearchInput {
  workspaceId: string;
  sessionId: string;
  scope?: Exclude<MemoryScope, "hybrid">;
  query: string;
  limit?: number;
  kinds?: MemoryItemKind[];
}

export interface MemoryStatsInput {
  workspaceId: string;
  sessionId: string;
  scope?: Exclude<MemoryScope, "hybrid">;
}

export interface MemoryStatsOutput {
  facts: number;
  summaries: number;
  total: number;
  transcriptMessages: number;
  memoryTokens: number;
  transcriptTokens: number;
}

export interface MemoryRecentInput {
  workspaceId: string;
  sessionId: string;
  scope?: Exclude<MemoryScope, "hybrid">;
  limit?: number;
  kinds?: MemoryItemKind[];
}

export interface MemoryClearInput {
  workspaceId: string;
  sessionId: string;
  scope?: Exclude<MemoryScope, "hybrid">;
}

export interface MemoryContextInput {
  workspaceId: string;
  sessionId: string;
  prompt: string;
  scope?: MemoryScope;
  budgetTokens?: number;
}

export interface MemoryContextOutput {
  sessionId: string;
  budgetTokens: number;
  totalTokens: number;
  hot: TranscriptMessage[];
  warm: MemoryItem[];
  cold: MemoryItem[];
  rendered: string;
}

export interface MemoryProvider {
  id: string;
  recordTurn: (input: MemoryTurnInput) => void;
  getStats: (input: MemoryStatsInput) => MemoryStatsOutput;
  getRecent: (input: MemoryRecentInput) => MemoryItem[];
  search: (input: MemorySearchInput) => MemoryItem[];
  getContext: (input: MemoryContextInput) => MemoryContextOutput;
  clear: (input: MemoryClearInput) => number;
}

export interface SqliteMemoryProviderConfig {
  contextBudgetTokens?: number;
  hotMessageCount?: number;
  warmSummaryCount?: number;
  coldFactCount?: number;
  workspaceSummaryCount?: number;
  workspaceFactCount?: number;
  maxFactsPerTurn?: number;
  maxFactLength?: number;
  summaryWindowMessages?: number;
}

export interface NormalizedMemoryConfig {
  contextBudgetTokens: number;
  hotMessageCount: number;
  warmSummaryCount: number;
  coldFactCount: number;
  workspaceSummaryCount: number;
  workspaceFactCount: number;
  maxFactsPerTurn: number;
  maxFactLength: number;
  summaryWindowMessages: number;
}
