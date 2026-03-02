import type { MemoryItem, MemoryItemKind, TranscriptMessage } from "@nexus/types";

export interface MemoryTurnInput {
  sessionId: string;
  userText: string;
  assistantText?: string;
  timestamp?: string;
}

export interface MemorySearchInput {
  sessionId: string;
  query: string;
  limit?: number;
  kinds?: MemoryItemKind[];
}

export interface MemoryContextInput {
  sessionId: string;
  prompt: string;
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
  search: (input: MemorySearchInput) => MemoryItem[];
  getContext: (input: MemoryContextInput) => MemoryContextOutput;
}

export interface SqliteMemoryProviderConfig {
  contextBudgetTokens?: number;
  hotMessageCount?: number;
  warmSummaryCount?: number;
  coldFactCount?: number;
  maxFactsPerTurn?: number;
  maxFactLength?: number;
  summaryWindowMessages?: number;
}

export interface NormalizedMemoryConfig {
  contextBudgetTokens: number;
  hotMessageCount: number;
  warmSummaryCount: number;
  coldFactCount: number;
  maxFactsPerTurn: number;
  maxFactLength: number;
  summaryWindowMessages: number;
}
