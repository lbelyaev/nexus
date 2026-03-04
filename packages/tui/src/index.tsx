#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { closeSync, openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";
import type { RenderOptions } from "ink";
import { App } from "./App.js";
import { enableSyncOutput } from "./syncOutput.js";

const disableSyncOutput = enableSyncOutput();

const url = process.env.NEXUS_URL ?? process.env.NEXT_PUBLIC_NEXUS_URL ?? "ws://127.0.0.1:18800/ws";
const token = process.env.NEXUS_TOKEN ?? process.env.NEXT_PUBLIC_NEXUS_TOKEN ?? "";

interface InkStreams {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  close?: () => void;
}

const resolveInkStreams = (): InkStreams => {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return {};
  }

  try {
    // Bun can mark process.stdin/process.stdout as non-TTY wrappers
    // while the underlying fd 0/1 still point to a terminal.
    const fdIn = new ReadStream(0);
    const fdOut = new WriteStream(1);
    if (fdIn.isTTY && fdOut.isTTY) {
      return {
        stdin: fdIn,
        stdout: fdOut,
      };
    }
  } catch {
    // Fall through to /dev/tty fallback.
  }

  let inFd: number | undefined;
  let outFd: number | undefined;
  try {
    // Bun workspace runners can proxy stdin/stdout as non-TTY streams.
    // Opening /dev/tty preserves Ink raw-mode input behavior.
    inFd = openSync("/dev/tty", "r");
    outFd = openSync("/dev/tty", "w");
    return {
      stdin: new ReadStream(inFd),
      stdout: new WriteStream(outFd),
      close: () => {
        if (inFd !== undefined) closeSync(inFd);
        if (outFd !== undefined) closeSync(outFd);
      },
    };
  } catch {
    if (inFd !== undefined) closeSync(inFd);
    if (outFd !== undefined) closeSync(outFd);
    return {};
  }
};

const streams = resolveInkStreams();
if (!process.stdin.isTTY && !streams.stdin) {
  process.stderr.write(
    "Nexus TUI requires a TTY for raw input mode. Run from an interactive terminal or start from packages/tui directly.\n",
  );
  process.exit(1);
}

const renderOptions: RenderOptions = {};
if (streams.stdin) renderOptions.stdin = streams.stdin;
if (streams.stdout) renderOptions.stdout = streams.stdout;

const instance = render(<App url={url} token={token} />, renderOptions);
instance.waitUntilExit().then(() => {
  disableSyncOutput();
  streams.close?.();
});
