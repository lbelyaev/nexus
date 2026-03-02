import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import type { NexusConfig, RuntimeProfile } from "@nexus/types";
import { generateToken } from "./auth.js";

const DEFAULTS: Omit<NexusConfig, "runtime" | "auth"> & {
  auth: { token: string };
} = {
  port: 18800,
  host: "127.0.0.1",
  auth: { token: "" },
  dataDir: "./data",
};

const findRepoRoot = (): string => {
  let dir = process.cwd();
  while (dir !== dirname(dir)) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.workspaces) return dir;
      } catch { /* skip */ }
    }
    dir = dirname(dir);
  }
  return process.cwd();
};

export const repoRoot = findRepoRoot();

const CONFIG_SEARCH_PATHS = [
  resolve(repoRoot, "config/nexus.json"),
  resolve(repoRoot, "config/nexus.default.json"),
];

export const loadConfig = (configPath?: string): NexusConfig => {
  const resolvedPath = configPath
    ?? process.env.NEXUS_CONFIG
    ?? CONFIG_SEARCH_PATHS.find((p) => existsSync(p));

  if (!resolvedPath || !existsSync(resolvedPath)) {
    throw new Error(
      `Config file not found. Tried: ${configPath ?? "env:NEXUS_CONFIG, " + CONFIG_SEARCH_PATHS.join(", ")}`,
    );
  }

  const raw = JSON.parse(readFileSync(resolvedPath, "utf-8")) as Record<
    string,
    unknown
  >;

  const legacyRuntime = raw.runtime as RuntimeProfile | undefined;
  const runtimes = raw.runtimes as Record<string, RuntimeProfile> | undefined;
  const defaultRuntimeId = raw.defaultRuntimeId as string | undefined;

  const config: NexusConfig = {
    port: (raw.port as number) ?? DEFAULTS.port,
    host: (raw.host as string) ?? DEFAULTS.host,
    auth: {
      token:
        (raw.auth as Record<string, unknown> | undefined)?.token as string ??
        DEFAULTS.auth.token,
    },
    runtime: legacyRuntime,
    runtimes,
    defaultRuntimeId,
    modelRouting: raw.modelRouting as Record<string, string> | undefined,
    modelAliases: raw.modelAliases as Record<string, string> | undefined,
    modelCatalog: raw.modelCatalog as Record<string, string[]> | undefined,
    dataDir: (raw.dataDir as string) ?? DEFAULTS.dataDir,
  };

  const runtimeEntries = config.runtimes
    ? Object.entries(config.runtimes)
    : [];
  const hasRegistry = runtimeEntries.length > 0;
  const hasLegacy = !!config.runtime;

  if (!hasRegistry && !hasLegacy) {
    throw new Error("Invalid config: must provide either runtime or runtimes");
  }

  if (hasRegistry) {
    for (const [runtimeId, runtime] of runtimeEntries) {
      if (!Array.isArray(runtime.command) || runtime.command.length === 0) {
        throw new Error(`Invalid config: runtimes.${runtimeId}.command must be a non-empty array`);
      }
    }

    if (config.defaultRuntimeId && !config.runtimes?.[config.defaultRuntimeId]) {
      throw new Error(`Invalid config: defaultRuntimeId "${config.defaultRuntimeId}" not found in runtimes`);
    }
  }

  if (hasLegacy && config.runtime) {
    if (!Array.isArray(config.runtime.command) || config.runtime.command.length === 0) {
      throw new Error("Invalid config: runtime.command must be a non-empty array");
    }
  }

  if (config.modelRouting) {
    const availableRuntimeIds = new Set<string>([
      ...(config.runtimes ? Object.keys(config.runtimes) : []),
      ...(config.runtime ? ["default"] : []),
    ]);
    for (const [model, runtimeId] of Object.entries(config.modelRouting)) {
      if (!model.trim()) {
        throw new Error("Invalid config: modelRouting keys must be non-empty strings");
      }
      if (!availableRuntimeIds.has(runtimeId)) {
        throw new Error(`Invalid config: modelRouting.${model} points to unknown runtime "${runtimeId}"`);
      }
    }
  }

  if (config.modelAliases) {
    for (const [alias, model] of Object.entries(config.modelAliases)) {
      if (!alias.trim()) {
        throw new Error("Invalid config: modelAliases keys must be non-empty strings");
      }
      if (typeof model !== "string" || !model.trim()) {
        throw new Error(`Invalid config: modelAliases.${alias} must be a non-empty string`);
      }
    }
  }

  if (config.modelCatalog) {
    const availableRuntimeIds = new Set<string>([
      ...(config.runtimes ? Object.keys(config.runtimes) : []),
      ...(config.runtime ? ["default"] : []),
    ]);
    for (const [runtimeId, models] of Object.entries(config.modelCatalog)) {
      if (!availableRuntimeIds.has(runtimeId)) {
        throw new Error(`Invalid config: modelCatalog.${runtimeId} points to unknown runtime`);
      }
      if (!Array.isArray(models) || models.some((m) => typeof m !== "string" || !m.trim())) {
        throw new Error(`Invalid config: modelCatalog.${runtimeId} must be an array of non-empty strings`);
      }
    }
  }

  if (!config.auth.token) {
    config.auth.token = generateToken();
  }

  return config;
};
