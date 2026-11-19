import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { git } from "./feature-fixture.mjs";

export { git };

export function storePlanningFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "runner-store-planning-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const storeRoot = join(dir, "store"), code = join(dir, "code");
  for (const root of [storeRoot, code]) {
    mkdirSync(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Plan Test");
    git(root, "config", "user.email", "plan@example.test");
    git(root, "config", "core.autocrlf", "false");
  }
  git(storeRoot, "config", "openspec-runner.repository", "contracts");
  git(code, "commit", "--allow-empty", "-m", "Code base");
  const write = (path, content) => {
    mkdirSync(dirname(join(storeRoot, path)), { recursive: true });
    writeFileSync(join(storeRoot, path), content);
  };
  const config = component => JSON.stringify({
    version: 2, defaultAgent: "codex", agents: { codex: { defaultModel: component, planningRules: "guidance.md" } },
  });
  for (const component of ["api", "web"]) {
    const project = `components/${component}`;
    write(`${project}/openspec/runner.yaml`, config(component));
    write(`${project}/openspec/config.yaml`, "schema: spec-driven\n");
    write(`${project}/openspec/changes/demo/tasks.md`, "- [ ] 1.1 Deliver change\n");
    write(`${project}/openspec/changes/demo/execution.yaml`, 'version: 2\ntasks:\n  "1.1": {}\n');
    write(`${project}/openspec/specs/contract/spec.md`, `Approved ${component} specification\n`);
    write(`${project}/guidance.md`, "\ufeffRules\r\n");
  }
  write("runner/features/feature/event.json", "{}");
  git(storeRoot, "add", "."); git(storeRoot, "commit", "-m", "Store plans");
  const revision = git(storeRoot, "rev-parse", "HEAD");
  const input = (component = "api") => {
    const project = join(storeRoot, "components", component);
    const execute = ({ cwd, args }) => {
      if (cwd !== project) throw new Error(`Unexpected OpenSpec project: ${cwd}`);
      if (args[0] === "status") return JSON.stringify({
        root: { source: "nearest", path: project }, planningHome: { root: project },
        changeRoot: "openspec/changes/demo", artifactPaths: {},
      });
      if (args[0] === "doctor") return '{"references":[]}';
      if (args[0] === "instructions") return '{"state":"ready"}';
      if (args[0] === "validate" && args.includes("--strict")) return '{"items":[]}';
      throw new Error(`Unexpected OpenSpec command: ${args}`);
    };
    return { storeRoot, repository: "contracts", openspecRoot: `components/${component}/openspec`, change: "demo", revision, execute };
  };
  return { dir, code, storeRoot, write, input };
}
