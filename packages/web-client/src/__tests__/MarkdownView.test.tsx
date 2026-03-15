import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "../components/NexusWebClient";

describe("MarkdownView", () => {
  it("preserves soft line breaks inside paragraphs", () => {
    const html = renderToStaticMarkup(<MarkdownView text={"Line 1\nLine 2"} />);
    expect(html).toContain('<p class="whitespace-pre-wrap">Line 1\nLine 2</p>');
  });
});
