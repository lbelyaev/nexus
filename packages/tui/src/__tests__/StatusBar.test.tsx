import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect } from "vitest";
import { StatusBar } from "../components/StatusBar.js";

describe("StatusBar", () => {
  it("renders 'Connecting...' when status is connecting", () => {
    const { lastFrame } = render(<StatusBar status="connecting" />);
    expect(lastFrame()).toContain("Connecting...");
  });

  it("renders 'Connected' with model name when connected", () => {
    const { lastFrame } = render(
      <StatusBar status="connected" model="gpt-4" />
    );
    expect(lastFrame()).toContain("Connected");
    expect(lastFrame()).toContain("gpt-4");
  });

  it("renders 'Disconnected' when disconnected", () => {
    const { lastFrame } = render(<StatusBar status="disconnected" />);
    expect(lastFrame()).toContain("Disconnected");
  });
});
