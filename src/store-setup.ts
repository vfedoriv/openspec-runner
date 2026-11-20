import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { decodeManifest } from "./coordination-state.js";
import { configFrom } from "./plan.js";
import { storeCheckout, storeId, unredirectedStorePath } from "./planning-source.js";
import type { HarnessSettings } from "./harnesses/types.js";
import { repository } from "./system.js";
import { samePath } from "./platform-paths.js";

/** Bootstrap planning projects only; code repositories require no runner installation. */
export function initStore(options: { storeRoot: string; manifest: unknown }) {
  const manifest = decodeManifest({ value: options.manifest });
  if (manifest.version !== 2) throw new Error("Store setup requires a version-2 Store-backed manifest");
  const identities = [...new Set(Object.values(manifest.components).map(component => component.planning.repository))];
  if (identities.length !== 1) throw new Error("All component planning projects must identify the selected Store");
  const store = storeCheckout(options.storeRoot, identities[0]);
  const template = (roles: HarnessSettings[], setup: string[][] = [], verifyIntegration: string[][] = []) => {
    const agents = Object.fromEntries([...roles].reverse().map(role => [role.harness, { defaultModel: role.model,
      ...(role.harness === "claude" ? { permissionMode: "dontAsk", allowedTools: [] } : {}) }]));
    return { version: 2, defaultAgent: roles[0].harness, agents, maxParallel: 4, worktrees: "auto", terminal: "auto", cleanup: "automatic", setup, verifyIntegration };
  };
  const selections = [{ openspecRoot: "openspec", config: template([{ harness: "codex", model: "session" }]) },
    ...Object.values(manifest.components).map(component => ({ openspecRoot: component.planning.openspecRoot,
      config: template([component.settings.implementation, component.settings.review, component.settings.repair, ...Object.values(component.settings.tasks)], component.settings.setup, component.settings.verifyIntegration) }))];
  // Validate every target before creating the first file.
  const projects = selections.map(selection => {
    const path = unredirectedStorePath(store.root, selection.openspecRoot, "runner.yaml");
    const created = !existsSync(path), content = created ? stringify(selection.config) : readFileSync(path, "utf8");
    configFrom(parse(content));
    return { path, openspecRoot: selection.openspecRoot, created, content };
  });
  for (const project of projects) if (project.created) {
    mkdirSync(dirname(project.path), { recursive: true });
    unredirectedStorePath(store.root, project.openspecRoot, "runner.yaml");
    writeFileSync(project.path, project.content, { flag: "wx" });
  }
  return { storeRoot: store.root, featureId: manifest.featureId, projects: projects.map(({ content, ...project }) => project) };
}

/** Select a planning project before an execution assignment exists. */
export function storeProjectRoot(storeRoot: string, componentId?: string) {
  const path = unredirectedStorePath(storeRoot);
  if (!samePath(repository(path).root, path)) throw new Error("Store checkout must be a Git repository root");
  const project = componentId ? ["components", storeId(componentId)] : [];
  return unredirectedStorePath(path, ...project);
}
