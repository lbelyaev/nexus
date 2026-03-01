import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect } from "vitest";
import { ToolStatus } from "../components/ToolStatus.js";

describe("ToolStatus", () => {
  it("renders nothing when no active tools", () => {
    const { lastFrame } = render(<ToolStatus activeTools={[]} />);
    expect(lastFrame()).toBe("");
  });

  it("renders tool name when one tool is active", () => {
    const { lastFrame } = render(
      <ToolStatus
        activeTools={[{ tool: "read_file", params: { path: "/tmp" } }]}
      />
    );
    expect(lastFrame()).toContain("read_file");
  });

  it("renders multiple tool names", () => {
    const { lastFrame } = render(
      <ToolStatus
        activeTools={[
          { tool: "read_file", params: {} },
          { tool: "write_file", params: {} },
        ]}
      />
    );
    expect(lastFrame()).toContain("read_file");
    expect(lastFrame()).toContain("write_file");
  });
});
