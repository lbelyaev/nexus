export type TableAlign = "left" | "center" | "right";

export const splitTableRow = (line: string): string[] => {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
};

export const isTableSeparatorCell = (cell: string): boolean => /^:?-{3,}:?$/.test(cell.trim());

export const parseTableAlignment = (cell: string): TableAlign => {
  const normalized = cell.trim();
  if (normalized.startsWith(":") && normalized.endsWith(":")) return "center";
  if (normalized.endsWith(":")) return "right";
  return "left";
};

export const padCell = (value: string, width: number, align: TableAlign): string => {
  if (value.length >= width) return value;
  const pad = width - value.length;
  if (align === "right") return `${" ".repeat(pad)}${value}`;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    const right = pad - left;
    return `${" ".repeat(left)}${value}${" ".repeat(right)}`;
  }
  return `${value}${" ".repeat(pad)}`;
};

export const renderTableRow = (cells: string[], widths: number[], aligns: TableAlign[]): string =>
  `| ${widths.map((width, idx) => padCell(cells[idx] ?? "", width, aligns[idx])).join(" | ")} |`;

export const renderTableSeparator = (widths: number[]): string =>
  `| ${widths.map((width) => "-".repeat(Math.max(3, width))).join(" | ")} |`;

interface ParsedTable {
  header: string[];
  aligns: TableAlign[];
  rows: string[][];
  widths: number[];
  /** Number of source lines consumed (header + separator + data rows). */
  lineCount: number;
}

/**
 * Try to parse a markdown table starting at `lines[startIndex]`.
 * Returns null if the lines don't form a valid table.
 */
export const parseTable = (lines: string[], startIndex: number): ParsedTable | null => {
  const header = splitTableRow(lines[startIndex] ?? "");
  const separator = startIndex + 1 < lines.length ? splitTableRow(lines[startIndex + 1] ?? "") : [];
  const isTable = (
    header.length >= 2
    && separator.length >= 2
    && header.length === separator.length
    && separator.every(isTableSeparatorCell)
  );
  if (!isTable) return null;

  const aligns = separator.map(parseTableAlignment);
  const rows: string[][] = [];
  let j = startIndex + 2;
  while (j < lines.length) {
    const row = splitTableRow(lines[j] ?? "");
    if (row.length < 2) break;
    if (row.every(isTableSeparatorCell)) break;
    rows.push(row);
    j += 1;
  }

  const colCount = header.length;
  const normalizedRows = rows.map((row) =>
    Array.from({ length: colCount }, (_unused, idx) => row[idx] ?? ""));
  const widths = Array.from({ length: colCount }, (_unused, idx) =>
    Math.max(
      header[idx]?.length ?? 0,
      ...normalizedRows.map((row) => row[idx]?.length ?? 0),
    ));

  return {
    header,
    aligns,
    rows: normalizedRows,
    widths,
    lineCount: j - startIndex,
  };
};

/**
 * Render a parsed table as aligned plain-text lines (no wrapping — caller adds fences/tags).
 */
export const renderTablePlainText = (table: ParsedTable): string[] => {
  const lines: string[] = [];
  lines.push(renderTableRow(table.header, table.widths, table.aligns));
  lines.push(renderTableSeparator(table.widths));
  for (const row of table.rows) {
    lines.push(renderTableRow(row, table.widths, table.aligns));
  }
  return lines;
};

/**
 * Walk through markdown text, detect tables (skipping code fences), and call
 * `wrapTable` to produce platform-specific wrapping for each table block.
 */
export const formatMarkdownTables = (
  text: string,
  wrapTable: (plainTextLines: string[]) => string[],
): string => {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = (line ?? "").trim();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      if (!inFence) {
        inFence = true;
        fenceMarker = trimmed.slice(0, 3);
      } else if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
      }
      out.push(line ?? "");
      continue;
    }

    if (inFence) {
      out.push(line ?? "");
      continue;
    }

    const table = parseTable(lines, i);
    if (!table) {
      out.push(line ?? "");
      continue;
    }

    const plainLines = renderTablePlainText(table);
    out.push(...wrapTable(plainLines));
    i += table.lineCount - 1;
  }

  return out.join("\n");
};
