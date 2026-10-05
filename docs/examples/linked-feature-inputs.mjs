// Checked by test/coordination-cli.test.mjs. These files stay outside portable Store records.
import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function linkedFeatureInputs({ storeRoot, apiRoot, model, featureId = "checkout-promo", sharedChange = "checkout-promo", change = "implement-checkout-promo-api", deliveryBranch, coordinationBranch }) {
  if (![storeRoot, apiRoot, model, deliveryBranch, coordinationBranch].every(value => typeof value === "string" && value.trim())) throw new Error("Explicit Store/API paths, discovered model, component delivery branch and coordination branch are required");
  const role = { harness: "codex", model, effort: "high" };
  const settings = { implementation: role, tasks: {}, review: role, repair: role, maxFixRounds: 2, setup: [], verifyIntegration: [] };
  return {
    map: { contracts: resolve(storeRoot), api: resolve(apiRoot) },
    settings,
    manifest: { version: 1, featureId, storeId: "team", sharedChange, coordinationBranch,
      components: { api: { repository: "api", change, deliveryBranch, settings, dependencies: [] } },
      taskMapping: { "1.1": [{ type: "merged", componentId: "api" }] }, verification: [], completion: { requireAllMerged: true } },
    scope: { componentIds: ["api"], includeStore: true, storeDeliveryBranch: coordinationBranch },
    resources: { worktrees: "git", terminal: "manual", worktreeRoot: resolve(apiRoot, ".openspec-runner/worktrees") },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: Object.fromEntries(["store", "api", "model", "delivery-branch", "coordination-branch", "out"].map(name => [name, { type: "string" }])) });
  if (!values.out) throw new Error("--out must be an external local input directory");
  const inputs = linkedFeatureInputs({ storeRoot: values.store, apiRoot: values.api, model: values.model, deliveryBranch: values["delivery-branch"], coordinationBranch: values["coordination-branch"] });
  const output = resolve(values.out); mkdirSync(output, { recursive: true });
  for (const [name, content] of Object.entries(inputs)) writeFileSync(resolve(output, `${name}.json`), JSON.stringify(content, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ output, files: Object.keys(inputs).map(name => `${name}.json`) }, null, 2));
}
