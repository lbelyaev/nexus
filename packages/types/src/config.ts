// Config types

export interface RuntimeProfile {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  defaultModel?: string;
}

export interface MemoryConfig {
  enabled?: boolean;
  provider?: "sqlite";
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

export interface NexusConfig {
  port: number;
  host: string;
  auth: { token: string };
  runtime?: RuntimeProfile;
  runtimes?: Record<string, RuntimeProfile>;
  defaultRuntimeId?: string;
  modelRouting?: Record<string, string>;
  modelAliases?: Record<string, string>;
  modelCatalog?: Record<string, string[]>;
  workspaceDefaultId?: string;
  memory?: MemoryConfig;
  dataDir: string;
}
