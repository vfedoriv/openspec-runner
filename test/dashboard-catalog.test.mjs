import assert from "node:assert/strict";
import test from "node:test";
import { loadPickerCatalog } from "../dist/dashboard-catalog.js";

const codex = { harness: "codex", status: "available", entries: [{ selector: "example" }] };

test("the picker reuses a fresh catalog and keeps it when forced refresh fails", async () => {
  const cache = new Map();
  const { signal } = new AbortController();
  let reads = 0;
  const read = async () => { reads++; return codex; };
  const shown = [];
  const show = (...args) => shown.push(args);
  await loadPickerCatalog(cache, "codex", signal, read, show);
  await loadPickerCatalog(cache, "codex", signal, read, show);
  assert.equal(reads, 1);
  assert.deepEqual(shown.at(-1), [codex, ""]);
  cache.get("codex").fetchedAt = 0;
  await loadPickerCatalog(cache, "codex", signal, async () => { throw new Error("offline"); }, show);
  assert.deepEqual(shown.at(-1), [codex, "Cached catalog · refresh failed"]);
});

test("switching harnesses discards a pending picker response", async () => {
  const cache = new Map();
  const controller = new AbortController();
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const shown = [];
  const show = (...args) => shown.push(args);
  const previous = loadPickerCatalog(cache, "codex", controller.signal, () => response, show);
  controller.abort();
  const copilot = { harness: "copilot", status: "available", entries: [{ selector: "auto" }] };
  await loadPickerCatalog(cache, "copilot", new AbortController().signal, async () => copilot, show);
  finish(codex);
  await previous;
  assert.deepEqual(shown.at(-1), [copilot, ""]);
  assert.equal(cache.has("codex"), false);
});

test("normalized catalogs omit hidden and malformed entries and preserve model effort", async () => {
  const { registerHarness } = await import("../dist/harnesses/registry.js");
  const { modelCatalog } = await import("../dist/model-catalog.js");
  registerHarness({
    id: "catalog-fixture",
    async models(options) {
      assert.equal(options.includeHidden, false);
      return {
        status: "available",
        models: [
          { model: "visible", displayName: "Visible model", supportedReasoningEfforts: [{ reasoningEffort: "high" }, 42], defaultReasoningEffort: "high" },
          { model: "hidden", hidden: true },
          { model: "invalid\nselector" },
          null,
        ],
      };
    },
  });
  const catalog = await modelCatalog("catalog-fixture");
  assert.equal(catalog.status, "available");
  assert.deepEqual(catalog.entries, [{
    selector: "visible", label: "Visible model", source: "discovered", efforts: ["high"], defaultEffort: "high",
  }]);
});
