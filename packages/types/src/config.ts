// Config types

export interface NexusConfig {
  port: number;
  host: string;
  auth: { token: string };
  runtime: {
    command: string[];
    cwd?: string;
  };
  dataDir: string;
}
