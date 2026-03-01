// Config types

export interface NexusConfig {
  port: number;
  host: string;
  auth: { token: string };
  runtime: {
    command: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  dataDir: string;
}
