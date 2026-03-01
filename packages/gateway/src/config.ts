import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import type { NexusConfig } from "@nexus/types";
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

  const config: NexusConfig = {
    port: (raw.port as number) ?? DEFAULTS.port,
    host: (raw.host as string) ?? DEFAULTS.host,
    auth: {
      token:
        (raw.auth as Record<string, unknown> | undefined)?.token as string ??
        DEFAULTS.auth.token,
    },
    runtime: raw.runtime as NexusConfig["runtime"],
    dataDir: (raw.dataDir as string) ?? DEFAULTS.dataDir,
  };

  if (
    !config.runtime ||
    !Array.isArray(config.runtime.command) ||
    config.runtime.command.length === 0
  ) {
    throw new Error(
      "Invalid config: runtime.command must be a non-empty array",
    );
  }

  if (!config.auth.token) {
    config.auth.token = generateToken();
  }

  return config;
};
