import { lstatSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { renderBasicSummary, renderNarrative } from "./summary-render.js";
import type { SummaryBundle, SummaryNarrative } from "./summary-types.js";

export function createPresentationBrief(options: { bundle: SummaryBundle; narrative?: SummaryNarrative; narrativeMarkdown?: string; audience: string; assets?: string[] }): { markdown: string; sourceDigest: string } {
  if (!options.audience.trim()) throw new Error("Presentation audience required");
  if (options.narrative && options.narrative.sourceDigest !== options.bundle.digest) throw new Error("Narrative source mismatch");
  return { sourceDigest: options.bundle.digest, markdown: ["# Presentation brief", `Audience: ${options.audience}`,
    `Source digest: ${options.bundle.digest}`, "Prepare a 5–7 slide outline: problem, resulting behavior, concrete example, supported benefit, verification and limitations, next steps.",
    "Review the outline in the requesting conversation. Expected benefits are not measured outcomes. Do not imply deployment or delivery beyond the evidence.",
    renderBasicSummary(options.bundle), options.narrative ? renderNarrative(options.narrative) : options.narrativeMarkdown ?? "Narrative enrichment is pending; use the evidence and preserve its gaps.",
    "## Supplied assets", ...(options.assets ?? []).map(path => `- ${path}`), "No automatic screenshots, installation, publication or provider execution.", ""].join("\n\n") };
}
export function readPresentationProvider(options: { file: string }): { skillPath: string; version?: string } {
  const input = JSON.parse(readFileSync(options.file, "utf8"));
  if (!input || typeof input !== "object" || typeof input.skillPath !== "string" || !input.skillPath.trim() ||
    Object.keys(input).some(key => !["skillPath", "version"].includes(key)) || (input.version !== undefined && typeof input.version !== "string")) throw new Error("Invalid provider configuration");
  const skillPath = resolve(dirname(resolve(options.file)), input.skillPath);
  const stat = lstatSync(skillPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Provider skill must be a regular readable file");
  readFileSync(skillPath, "utf8");
  return { skillPath, ...(input.version ? { version: input.version } : {}) };
}
