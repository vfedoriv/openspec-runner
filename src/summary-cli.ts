import { parseArgs } from "node:util";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPresentationBrief, readPresentationProvider } from "./presentation-brief.js";
import { resolveSummary, ensureSummary } from "./summary-service.js";
import { readSummary, publishNarrative, exportSummary } from "./summary-store.js";
import { summaryDigest } from "./summary-evidence.js";
import type { SummaryHandle, SummaryRequest } from "./summary-types.js";

export function formatSummaryResult(handle: SummaryHandle): string {
  return `${handle.synopsis}\nSummary: ${handle.basic}; narrative: ${handle.narrative}\n${handle.paths?.narrative ?? handle.paths?.basic ?? ""}${handle.warning ? `\n${handle.warning}\nRetry summary work with --refresh; do not repeat implementation.` : ""}${handle.narrative === "pending" ? "\nA coordinating agent can enrich this summary using openspec-runner-summarize." : ""}`;
}
export function summaryCommand(options: { cwd: string; args: string[] }): void {
  const shared = options.args[0] === "coordination";
  const { values: v, positionals: p } = parseArgs({ args: options.args, allowPositionals: true, options: {
    json: { type: "boolean" }, task: { type: "string" }, refresh: { type: "boolean" }, export: { type: "string" },
    source: { type: "string" }, file: { type: "string" }, "expected-revision": { type: "string" },
    publish: { type: "boolean" }, store: { type: "string" }, map: { type: "string" },
    "presentation-brief": { type: "string" }, audience: { type: "string" }, "provider-config": { type: "string" }, assets: { type: "string" },
  } });
  const publish = shared ? !!v.publish : p[1] === "publish";
  const name = shared ? p[2] : p[publish ? 2 : 1];
  if (!name || p.length !== (shared || publish ? 3 : 2)) throw new Error("Use summary CHANGE or summary publish CHANGE");
  if (shared && v.task || !shared && (v.store || v.map || v.publish)) throw new Error("Invalid local/shared summary options");
  if ([!!v.refresh, !!v.export, publish, !!v["presentation-brief"]].filter(Boolean).length > 1) throw new Error("Summary modes are mutually exclusive");
  if (!v["presentation-brief"] && (v.audience || v.assets || v["provider-config"])) throw new Error("Presentation options require --presentation-brief");
  if (!publish && (v.source || v.file || v["expected-revision"])) throw new Error("Publishing options require publish mode");
  if (shared && (!v.store || !v.map)) throw new Error("Shared summary requires --store and --map");
  const request: SummaryRequest = shared ? { cwd: options.cwd, featureId: name, store: v.store!, map: v.map! } : { cwd: options.cwd, change: name, task: v.task };
  const { stateDir, bundle } = resolveSummary(request);
  let handle = readSummary({ stateDir, subject: bundle.evidence.subject, sourceDigest: bundle.digest });
  let result: unknown;
  if (v["presentation-brief"]) {
    if (!v.audience) throw new Error("--audience is required for a presentation brief");
    const assets = v.assets ? JSON.parse(readFileSync(v.assets, "utf8")) : [];
    if (!Array.isArray(assets) || assets.some(a => typeof a !== "string" || !a.trim())) throw new Error("--assets requires a JSON array of paths");
    let provider: ReturnType<typeof readPresentationProvider> | undefined, warning: string | undefined;
    try { if (v["provider-config"]) provider = readPresentationProvider({ file: v["provider-config"] }); }
    catch (error: any) { warning = error.message; }
    const exported = exportSummary({ stateDir, bundle, directory: v["presentation-brief"] });
    const portableBundle = JSON.parse(readFileSync(resolve(exported.directory, "evidence.json"), "utf8"));
    portableBundle.digest = bundle.digest;
    const narrativeMarkdown = exported.files.includes("narrative.md") ? readFileSync(resolve(exported.directory, "narrative.md"), "utf8") : undefined;
    const brief = createPresentationBrief({ bundle: portableBundle, narrativeMarkdown, audience: v.audience, assets });
    writeFileSync(resolve(exported.directory, "brief.md"), brief.markdown, { flag: "wx" });
    writeFileSync(resolve(exported.directory, "provider.json"), JSON.stringify({ sourceDigest: bundle.digest, provider, warning: warning ?? (!provider ? "Configure an installed presentation skill using --provider-config FILE; no provider was invoked." : undefined) }, null, 2), { flag: "wx" });
    result = { ...exported, files: [...exported.files, "brief.md", "provider.json"], provider, warning, sourceDigest: bundle.digest,
      ...(!provider ? { instruction: "Configure an installed presentation provider with --provider-config FILE; the brief is ready and no provider was invoked." } : {}) };
  }
  else if (v.refresh) { handle = ensureSummary(request); result = { available: true, summary: handle }; }
  else if (v.export) result = exportSummary({ stateDir, bundle, directory: v.export });
  else if (publish) {
    if (!v.file || !v.source || v.source !== bundle.digest) throw new Error("Existing current source digest and narrative file required");
    if (statSync(v.file).size > 1024 * 1024) throw new Error("Narrative exceeds 1 MiB");
    const narrative = JSON.parse(readFileSync(v.file, "utf8"));
    if (summaryDigest(resolveSummary(request).bundle.evidence) !== bundle.digest) throw new Error("Summary source became stale");
    handle = publishNarrative({ stateDir, bundle, narrative, expectedRevision: v["expected-revision"], currentSource: () => resolveSummary(request).bundle.digest });
    result = { available: true, summary: handle };
  } else result = { available: !!handle, sourceDigest: bundle.digest, summary: handle, ...(handle ? {} : { instruction: "Run summary with --refresh to create the basic artifact." }) };
  if (v.json) console.log(JSON.stringify(result, null, 2));
  else if (!v.export && !v["presentation-brief"] && handle) console.log(readFileSync(handle.paths!.narrative ?? handle.paths!.basic, "utf8"));
  else console.log(JSON.stringify(result, null, 2));
}
