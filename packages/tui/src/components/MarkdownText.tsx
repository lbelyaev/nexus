import React from "react";
import { Box, Text, type TextProps } from "ink";

interface InlineToken {
  kind: "text" | "bold" | "italic" | "code" | "link";
  value: string;
  url?: string;
}

export interface MarkdownTextProps {
  text: string;
  color?: TextProps["color"];
}

type TableAlign = "left" | "center" | "right";

const stripInlineMarkdown = (text: string): string =>
  text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1");

const splitTableRow = (line: string): string[] => {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => stripInlineMarkdown(cell.trim()));
};

const isTableSeparatorCell = (cell: string): boolean => /^:?-{3,}:?$/.test(cell.trim());

const parseTableAlignment = (cell: string): TableAlign => {
  const normalized = cell.trim();
  if (normalized.startsWith(":") && normalized.endsWith(":")) return "center";
  if (normalized.endsWith(":")) return "right";
  return "left";
};

const isTableHeaderLine = (line: string): boolean => splitTableRow(line).length >= 2;

const isTableSeparatorLine = (line: string): boolean => {
  const cells = splitTableRow(line);
  return cells.length >= 2 && cells.every(isTableSeparatorCell);
};

const padTableCell = (value: string, width: number, align: TableAlign): string => {
  if (value.length >= width) return value;
  const padding = width - value.length;
  if (align === "right") return `${" ".repeat(padding)}${value}`;
  if (align === "center") {
    const left = Math.floor(padding / 2);
    const right = padding - left;
    return `${" ".repeat(left)}${value}${" ".repeat(right)}`;
  }
  return `${value}${" ".repeat(padding)}`;
};

const formatTableRow = (cells: string[], widths: number[], aligns: TableAlign[]): string => {
  const normalized = widths.map((_, idx) => cells[idx] ?? "");
  const body = normalized
    .map((cell, idx) => ` ${padTableCell(cell, widths[idx], aligns[idx])} `)
    .join("|");
  return `|${body}|`;
};

const tableBorder = (widths: number[]): string =>
  `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;

const parseInline = (text: string): InlineToken[] => {
  const tokens: InlineToken[] = [];
  let i = 0;

  const pushText = (value: string): void => {
    if (!value) return;
    const last = tokens[tokens.length - 1];
    if (last?.kind === "text") {
      last.value += value;
      return;
    }
    tokens.push({ kind: "text", value });
  };

  while (i < text.length) {
    if (text[i] === "[") {
      const labelEnd = text.indexOf("](", i + 1);
      if (labelEnd !== -1) {
        const urlEnd = text.indexOf(")", labelEnd + 2);
        if (urlEnd !== -1) {
          const label = text.slice(i + 1, labelEnd);
          const url = text.slice(labelEnd + 2, urlEnd);
          tokens.push({ kind: "link", value: label, url });
          i = urlEnd + 1;
          continue;
        }
      }
    }

    const boldDelimiter = text.startsWith("**", i)
      ? "**"
      : text.startsWith("__", i)
        ? "__"
        : null;
    if (boldDelimiter) {
      const close = text.indexOf(boldDelimiter, i + 2);
      if (close !== -1) {
        tokens.push({ kind: "bold", value: text.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
    }

    if (text[i] === "*" || text[i] === "_") {
      const delimiter = text[i];
      const close = text.indexOf(delimiter, i + 1);
      if (close !== -1) {
        tokens.push({ kind: "italic", value: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    if (text[i] === "`") {
      const close = text.indexOf("`", i + 1);
      if (close !== -1) {
        tokens.push({ kind: "code", value: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    pushText(text[i]);
    i += 1;
  }

  return tokens;
};

const renderInline = (text: string, keyPrefix: string, color?: TextProps["color"]): React.ReactNode[] =>
  parseInline(text).map((token, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (token.kind) {
      case "text":
        return (
          <Text key={key} color={color}>
            {token.value}
          </Text>
        );
      case "bold":
        return (
          <Text key={key} bold color={color}>
            {renderInline(token.value, `${key}-bold`, color)}
          </Text>
        );
      case "italic":
        return (
          <Text key={key} italic color={color}>
            {renderInline(token.value, `${key}-italic`, color)}
          </Text>
        );
      case "code":
        return (
          <Text key={key} color="yellow">
            {`[${token.value}]`}
          </Text>
        );
      case "link":
        return (
          <React.Fragment key={key}>
            <Text underline color="cyan">
              {token.value}
            </Text>
            {token.url ? (
              <Text dimColor>
                {` (${token.url})`}
              </Text>
            ) : null}
          </React.Fragment>
        );
    }
  });

export const MarkdownText = ({ text, color = "white" }: MarkdownTextProps) => {
  const lines = text.replace(/\r/g, "").split("\n");
  const nodes: React.ReactNode[] = [];
  let inFence = false;
  let fenceMarker = "";
  let codeLines: string[] = [];

  const flushCode = (key: string): void => {
    if (codeLines.length === 0) return;
    nodes.push(
      <Box key={key} flexDirection="column">
        {codeLines.map((line, idx) => (
          <Text key={`${key}-${idx}`} color="yellow">
            {`  ${line}`}
          </Text>
        ))}
      </Box>,
    );
    codeLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const key = `md-${i}`;

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      if (!inFence) {
        inFence = true;
        fenceMarker = trimmed.slice(0, 3);
      } else if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
        flushCode(`${key}-code`);
      }
      continue;
    }

    if (inFence) {
      codeLines.push(line);
      continue;
    }

    if (
      i + 1 < lines.length
      && isTableHeaderLine(line)
      && isTableSeparatorLine(lines[i + 1])
    ) {
      const header = splitTableRow(line);
      const separator = splitTableRow(lines[i + 1]);
      const alignments: TableAlign[] = header.map((_, idx) =>
        parseTableAlignment(separator[idx] ?? "---"));
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().includes("|")) {
        const cells = splitTableRow(lines[j]);
        if (cells.length < 2) break;
        rows.push(cells);
        j += 1;
      }

      const columnCount = header.length;
      const normalizedRows = rows.map((row) =>
        Array.from({ length: columnCount }, (_, idx) => row[idx] ?? ""));
      const widths = Array.from({ length: columnCount }, (_, idx) =>
        Math.max(
          header[idx]?.length ?? 0,
          ...normalizedRows.map((row) => row[idx]?.length ?? 0),
        ));

      nodes.push(
        <Box key={`${key}-table`} flexDirection="column">
          <Text color="gray">{tableBorder(widths)}</Text>
          <Text color="cyan">{formatTableRow(header, widths, alignments)}</Text>
          <Text color="gray">{tableBorder(widths)}</Text>
          {normalizedRows.map((row, rowIdx) => (
            <Text key={`${key}-table-row-${rowIdx}`} color={color}>
              {formatTableRow(row, widths, alignments)}
            </Text>
          ))}
          <Text color="gray">{tableBorder(widths)}</Text>
        </Box>,
      );
      i = j - 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const headingColor = level <= 2 ? "green" : "cyan";
      nodes.push(
        <Text key={key} bold color={headingColor}>
          {renderInline(heading[2], `${key}-h`, headingColor)}
        </Text>,
      );
      continue;
    }

    const ul = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (ul) {
      nodes.push(
        <Text key={key} color={color}>
          {"• "}
          {renderInline(ul[1], `${key}-ul`, color)}
        </Text>,
      );
      continue;
    }

    const ol = /^\s*(\d+)\.\s+(.+)$/.exec(line);
    if (ol) {
      nodes.push(
        <Text key={key} color={color}>
          {`${ol[1]}. `}
          {renderInline(ol[2], `${key}-ol`, color)}
        </Text>,
      );
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      nodes.push(
        <Text key={key} color="gray">
          {"│ "}
          {renderInline(quote[1], `${key}-q`, "gray")}
        </Text>,
      );
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      nodes.push(
        <Text key={key} color="gray">
          {"────────────────"}
        </Text>,
      );
      continue;
    }

    if (trimmed.length === 0) {
      nodes.push(
        <Text key={key}>
          {" "}
        </Text>,
      );
      continue;
    }

    nodes.push(
      <Text key={key} color={color}>
        {renderInline(line, `${key}-p`, color)}
      </Text>,
    );
  }

  if (inFence) {
    flushCode("md-code-trailing");
  }

  return <Box flexDirection="column">{nodes}</Box>;
};
