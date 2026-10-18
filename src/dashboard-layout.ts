import stringWidth from "string-width";
import { safeText } from "./dashboard-view.js";

export type DashboardLine = string | readonly [string, string, string];
type LayoutOptions = { columns: number; rows: number; table?: boolean; error?: string };
export type DashboardFrame = LayoutOptions & {
  title: string;
  status: string;
  filters: string;
  lines: DashboardLine[];
  footer: readonly [string, string];
};
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Terminal columns differ from string length for CJK, emoji, and combining marks.
export function fitDashboardText(value: string, width: number): string {
  const text = safeText(value).replace(/[\r\n\t]/g, " ");
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text + " ".repeat(width - stringWidth(text));
  let result = "", used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = stringWidth(segment);
    if (used + size > width - 1) break;
    result += segment; used += size;
  }
  return result + "…" + " ".repeat(width - used - 1);
}

export function dashboardLayout(options: LayoutOptions) {
  const width = Math.max(1, Math.floor(options.columns)), height = Math.max(1, Math.floor(options.rows));
  const compact = width < 70 || height < 18;
  const table = !!options.table && !compact;
  const tiny = height < 10 + (options.error ? 1 : 0) || width < 8;
  const tinyTitle = height >= 5, tinyFooter = height >= 4, tinyError = !!options.error && height >= 6;
  const overhead = (compact ? 9 : 11) + (table ? 2 : 0) + (options.error ? 1 : 0);
  const tinyOverhead = 2 + Number(tinyTitle) + Number(tinyFooter) + Number(tinyError);
  return { width, height, compact, table, tiny, tinyTitle, tinyFooter, tinyError, capacity: Math.max(1, height - (tiny ? tinyOverhead : overhead)) };
}

export function dashboardFrame(options: DashboardFrame): string[] {
  const { width, height, compact, table, tiny, tinyTitle, tinyFooter, tinyError, capacity } = dashboardLayout(options);
  const inner = Math.max(0, width - 2);
  const rule = (left: string, right: string) => left + "─".repeat(inner) + right;
  const row = (text: string) => `│${fitDashboardText(text, inner)}│`;
  const padded = (text: string) => row(` ${fitDashboardText(text, Math.max(0, inner - 2))} `);
  const plain = (line: DashboardLine) => typeof line === "string" ? line : line.filter(Boolean).join(" · ");
  if (width < 2 || height < 2) return [fitDashboardText(options.title, width)];
  if (tiny) {
    const content = [
      ...(tinyTitle ? [options.title] : []),
      ...(tinyError ? [options.error!] : []),
      ...options.lines.slice(0, capacity).map(plain),
      ...(tinyFooter ? [options.footer[0]] : []),
    ];
    return [rule("┌", "┐"), ...content.slice(0, height - 2).map(row), rule("└", "┘")];
  }
  const widths = [7, Math.floor((width - 17) * 0.42)];
  widths.push(width - 10 - widths[0] - widths[1]);
  const cells = (values: readonly string[]) => `│ ${values.map((value, index) => fitDashboardText(value, widths[index])).join(" │ ")} │`;
  const tableRule = (left: string, middle: string, right: string) => left + widths.map(size => "─".repeat(size + 2)).join(middle) + right;
  const result = [rule("┌", "┐"), padded(options.title)];
  if (!compact) result.push(rule("├", "┤"));
  result.push(padded(options.status));
  if (options.error) result.push(padded(options.error));
  if (!compact) result.push(rule("├", "┤"));
  result.push(padded(options.filters));
  if (table) result.push(tableRule("├", "┬", "┤"), cells(["Task", "Description", "State / reason"]), tableRule("├", "┼", "┤"));
  else result.push(rule("├", "┤"));
  for (let index = 0; index < capacity; index++) {
    const line = options.lines[index] ?? (table ? ["", "", ""] as const : "");
    result.push(table ? cells(typeof line === "string" ? ["", line, ""] : line) : padded(plain(line)));
  }
  result.push(table ? tableRule("├", "┴", "┤") : rule("├", "┤"), padded(options.footer[0]));
  if (!compact) result.push(padded(options.footer[1]));
  result.push(rule("└", "┘"));
  return result;
}
