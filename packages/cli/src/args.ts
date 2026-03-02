export interface CliArgs {
  url: string;
  token: string;
  sessionId?: string;
  runtimeId?: string;
  model?: string;
  prompt?: string;
  autoApprove: boolean;
  outputMode: "json" | "pretty";
  help: boolean;
}

const DEFAULT_URL = "ws://127.0.0.1:18800/ws";

const requireValue = (
  argv: string[],
  index: number,
  flag: string,
): string => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
};

export const parseCliArgs = (
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliArgs => {
  let url = env.NEXUS_URL ?? DEFAULT_URL;
  let token = env.NEXUS_TOKEN ?? "";
  let sessionId: string | undefined;
  let runtimeId: string | undefined;
  let model: string | undefined;
  let prompt: string | undefined;
  let autoApprove = false;
  let outputMode: "json" | "pretty" = "json";
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--url":
        url = requireValue(argv, i, "--url");
        i += 1;
        break;
      case "--token":
        token = requireValue(argv, i, "--token");
        i += 1;
        break;
      case "--session":
        sessionId = requireValue(argv, i, "--session");
        i += 1;
        break;
      case "--runtime":
        runtimeId = requireValue(argv, i, "--runtime");
        i += 1;
        break;
      case "--model":
        model = requireValue(argv, i, "--model");
        i += 1;
        break;
      case "--prompt":
        prompt = requireValue(argv, i, "--prompt");
        i += 1;
        break;
      case "--auto-approve":
        autoApprove = true;
        break;
      case "--json":
        outputMode = "json";
        break;
      case "--pretty":
        outputMode = "pretty";
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    url,
    token,
    sessionId,
    runtimeId,
    model,
    prompt,
    autoApprove,
    outputMode,
    help,
  };
};

export const validateCliArgs = (args: CliArgs): void => {
  if (!args.help && !args.token) {
    throw new Error("Missing token. Provide --token or set NEXUS_TOKEN.");
  }
};

export const CLI_USAGE = `nexus-cli [options]

Options:
  --url <ws-url>         Gateway URL (default: ws://127.0.0.1:18800/ws)
  --token <token>        Auth token (or NEXUS_TOKEN env var)
  --session <id>         Attach to existing session (skip session_new)
  --runtime <id>         Runtime to use for new sessions
  --model <id>           Model to use for new sessions
  --prompt <text>        One-shot mode: send prompt, print response, exit
  --auto-approve         Auto-approve all approval requests
  --json                 Raw JSON output mode (default)
  --pretty               Human-readable output mode
  --help, -h             Show this help`;
