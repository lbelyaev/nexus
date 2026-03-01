import React from "react";
import { Text, type TextProps } from "ink";
import { MarkdownText } from "./MarkdownText.js";

export type MarkdownRendererName = "plain" | "basic";

export interface MarkdownRendererProps {
  text: string;
  color?: TextProps["color"];
  renderer?: MarkdownRendererName;
}

export const MarkdownRenderer = ({
  text,
  color = "white",
  renderer = "basic",
}: MarkdownRendererProps) => {
  if (renderer === "plain") {
    return <Text color={color}>{text}</Text>;
  }
  return <MarkdownText text={text} color={color} />;
};
