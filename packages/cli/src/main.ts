#!/usr/bin/env node
import { createInterface } from "node:readline";
import { parseCliArgs, validateCliArgs, CLI_USAGE } from "./args.js";
import { createNexusCliClient } from "./client.js";
import { parseJsonLine, normalizeClientMessage, serializeGatewayEvent } from "./io.js";

const writeStdoutLine = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const writeStderrLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const formatUnknownError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
};

const hasMissingSessionId = (input: unknown): boolean => {
  if (typeof input !== "object" || input === null) return false;
  const obj = input as Record<string, unknown>;
  const type = obj.type;
  return (type === "prompt" || type === "cancel") && obj.sessionId === undefined;
};

const run = async (): Promise<number> => {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    writeStderrLine(error instanceof Error ? error.message : String(error));
    writeStderrLine(CLI_USAGE);
    return 1;
  }

  if (args.help) {
    writeStdoutLine(CLI_USAGE);
    return 0;
  }

  try {
    validateCliArgs(args);
  } catch (error) {
    writeStderrLine(error instanceof Error ? error.message : String(error));
    writeStderrLine(CLI_USAGE);
    return 1;
  }

  const client = createNexusCliClient({
    url: args.url,
    token: args.token,
    sessionId: args.sessionId,
  });

  let exitCode = 0;
  let sessionId = args.sessionId;
  let oneShotDone = false;
  let pendingPromptCount = 0;
  let stdinEnded = false;
  let connecting = true;
  const queuedMessages: unknown[] = [];

  const maybeCloseInteractive = (): void => {
    if (!args.prompt && stdinEnded && pendingPromptCount <= 0 && queuedMessages.length === 0) {
      client.close();
    }
  };

  const sendPrompt = (text: string): void => {
    if (!sessionId) {
      throw new Error("No active session. Wait for session_created.");
    }
    client.send({
      type: "prompt",
      sessionId,
      text,
    });
    pendingPromptCount += 1;
  };

  const dispatchInputMessage = (input: unknown): void => {
    const msg = normalizeClientMessage(input, sessionId);
    client.send(msg);
    if (msg.type === "prompt") {
      pendingPromptCount += 1;
    }
  };

  const flushQueuedMessages = (): void => {
    if (!sessionId || queuedMessages.length === 0) return;
    const pending = [...queuedMessages];
    queuedMessages.length = 0;
    for (const input of pending) {
      dispatchInputMessage(input);
    }
  };

  client.onOpen(() => {
    writeStderrLine("[nexus-cli] connected");
    if (!args.sessionId) {
      client.createSession(args.runtimeId, args.model);
    }
    if (args.prompt && args.sessionId) {
      try {
        sendPrompt(args.prompt);
      } catch (error) {
        writeStderrLine(`[nexus-cli] ${formatUnknownError(error)}`);
        exitCode = 1;
        client.close();
      }
    }
  });

  client.onEvent((event) => {
    writeStdoutLine(serializeGatewayEvent(event, args.outputMode));

    if (event.type === "session_created") {
      sessionId = event.sessionId;
      flushQueuedMessages();
      if (args.prompt && !args.sessionId && pendingPromptCount === 0) {
        try {
          sendPrompt(args.prompt);
        } catch (error) {
          writeStderrLine(`[nexus-cli] ${formatUnknownError(error)}`);
          exitCode = 1;
          client.close();
        }
      }
    }

    if (args.autoApprove && event.type === "approval_request") {
      client.send({
        type: "approval_response",
        requestId: event.requestId,
        allow: true,
      });
    }

    if (event.type === "turn_end") {
      if (pendingPromptCount > 0) {
        pendingPromptCount -= 1;
      }

      if (args.prompt && sessionId && event.sessionId === sessionId) {
        oneShotDone = true;
        client.close();
        return;
      }

      maybeCloseInteractive();
    }
  });

  client.onError((error) => {
    if (connecting) return;
    writeStderrLine(`[nexus-cli] error: ${error.message}`);
    exitCode = 1;
  });

  const closePromise = new Promise<number>((resolve) => {
    client.onClose(() => {
      if (!connecting) {
        writeStderrLine("[nexus-cli] disconnected");
      }
      if (args.prompt && !oneShotDone) {
        resolve(1);
        return;
      }
      resolve(exitCode);
    });
  });

  try {
    await client.connect();
    connecting = false;
  } catch (error) {
    writeStderrLine(`[nexus-cli] failed to connect: ${formatUnknownError(error)}`);
    return 1;
  }

  if (!args.prompt) {
    const rl = createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
      terminal: false,
    });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const parsed = parseJsonLine(trimmed);
        if (!sessionId && hasMissingSessionId(parsed)) {
          queuedMessages.push(parsed);
          return;
        }
        dispatchInputMessage(parsed);
      } catch (error) {
        writeStderrLine(`[nexus-cli] input error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    rl.on("close", () => {
      stdinEnded = true;
      maybeCloseInteractive();
    });
  }

  return closePromise;
};

run().then((code) => {
  process.exit(code);
});
