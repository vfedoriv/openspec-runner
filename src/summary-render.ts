import type { SummaryBundle, SummaryNarrative } from "./summary-types.js";

export function renderBasicSummary(bundle: SummaryBundle): string {
  const e = bundle.evidence;
  return [`# Work summary`, `Source: ${bundle.digest}`, `Lifecycle: ${e.lifecycle}`, ...[
    ["Intent", ["intent"]], ["Implemented work", ["work", "repair"]], ["Verification", ["verification", "review"]],
    ["Limitations", ["limitation"]], ["Delivery", ["delivery"]],
  ].flatMap(([title, categories]) => [`## ${title}`, ...e.facts.filter(f => (categories as string[]).includes(f.category))
    .map(f => `- ${f.text} [${f.authority}; ${f.id}]`)]),
  "## Evidence gaps", ...e.gaps.map(g => `- ${g}`), ""].join("\n\n");
}
export function renderNarrative(narrative: SummaryNarrative): string {
  return Object.entries(narrative.sections).map(([name, claims]) => `## ${name}\n\n${claims.length ? claims.map(c =>
    `- ${c.expectedBenefit ? "Expected benefit: " : ""}${c.text} [${c.evidenceIds.join(", ")}]`).join("\n") : "No supported evidence supplied."}`).join("\n\n") + "\n";
}
