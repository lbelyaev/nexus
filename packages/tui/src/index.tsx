#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import { enableSyncOutput } from "./syncOutput.js";

const disableSyncOutput = enableSyncOutput();

const url = process.env.NEXUS_URL ?? "ws://127.0.0.1:18800/ws";
const token = process.env.NEXUS_TOKEN ?? "";

const instance = render(<App url={url} token={token} />);
instance.waitUntilExit().then(disableSyncOutput);
