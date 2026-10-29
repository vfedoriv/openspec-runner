import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPath, containedPath, samePath } from "../platform-paths.js";
import { run } from "../system.js";
import type { Invocation, ManagedInvocationContext } from "./types.js";

export function codexWorkerPermissions(input: ManagedInvocationContext & { cwd: string }) {
  const cwd = canonicalPath(input.cwd), common = canonicalPath(input.common), gitDir = canonicalPath(input.gitDir);
  const pointer = readFileSync(join(cwd, ".git"), "utf8").trim().match(/^gitdir: (.+)$/);
  if (!pointer || !samePath(resolve(cwd, pointer[1]), gitDir) ||
      !containedPath(join(common, "worktrees"), gitDir) || samePath(common, gitDir) ||
      !samePath(resolve(gitDir, readFileSync(join(gitDir, "gitdir"), "utf8").trim()), join(cwd, ".git")))
    throw new Error("Codex worker Git administrative directory/worktree identity mismatch");
  if (!/^openspec-runner\/[A-Za-z0-9_./-]+$/.test(input.branch) || input.branch.includes("..") ||
      input.branch.split("/").some(part => !part || part === ".") ||
      readFileSync(join(gitDir, "HEAD"), "utf8").trim() !== `ref: refs/heads/${input.branch}`)
    throw new Error("Codex worker branch identity mismatch");
  const reports = resolve(dirname(cwd), "reports"), runtime = join(common, "openspec-runner");
  const name = `openspec_runner_${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}`;
  const temp = join(runtime, "tmp", basename(cwd));
  const ref = join(common, "refs", "heads", input.branch), log = join(common, "logs", "refs", "heads", input.branch);
  const filesystem: Record<string, "read" | "write"> = { [common]: "read" };
  // Windows needs directory create rights for Git's transient .lock files;
  // granting only the not-yet-existing file does not provide those rights.
  for (const path of [gitDir, join(common, "objects"), runtime, dirname(ref), dirname(log), ref, `${ref}.lock`, log, `${log}.lock`]) {
    if (!containedPath(common, path)) throw new Error("Codex worker Git write path escapes its repository");
    filesystem[path] = "write";
  }
  filesystem[reports] = "write";
  filesystem[fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "")] = "read";
  const profile = { extends: ":workspace", filesystem };
  // Encode the whole table: splitting a CLI dotted key containing a Windows
  // path (especially .git) changes its meaning, even when the key is quoted.
  const table = Object.entries(filesystem).map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(",");
  return { name, profile, prepareDirectories: [reports, temp], env: { TEMP: temp, TMP: temp, TMPDIR: temp },
    configArgs: ["-c", `default_permissions=${JSON.stringify(name)}`, "-c", `permissions.${name}={extends=":workspace",filesystem={${table}}}`] };
}

export function scopedCodexInvocation(invocation: Invocation, context: ManagedInvocationContext): Invocation {
  const policy = codexWorkerPermissions({ ...context, cwd: invocation.cwd });
  const args: string[] = [];
  for (let index = 0; index < invocation.args.length; index++) {
    if (invocation.args[index] === "--add-dir" && invocation.args[index + 1] && samePath(invocation.args[index + 1], context.common)) { index++; continue; }
    args.push(invocation.args[index]);
  }
  args.splice(args[0] === "exec" || args[0] === "resume" ? 1 : 0, 0, "--strict-config", ...policy.configArgs);
  return { ...invocation, args, env: { ...invocation.env, ...policy.env }, prepareDirectories: policy.prepareDirectories };
}

/** Inspect Codex's effective permissions without starting a model session. */
export function validateCodexInvocation(invocation: Invocation, context: ManagedInvocationContext): void {
  const policy = codexWorkerPermissions({ ...context, cwd: invocation.cwd });
  try {
    assertEffectiveCodexPermissions(JSON.parse(run(invocation.executable,
      ["debug", "prompt-input", ...policy.configArgs], invocation.cwd, 30000)), policy);
  } catch (error: any) {
    throw new Error(`Codex Windows worker permissions could not be verified: ${error.message}. Use a Codex CLI supporting named permission profiles and remove legacy sandbox_mode/sandbox_workspace_write overrides from loaded configuration; no model was started.`);
  }
}

export function assertEffectiveCodexPermissions(output: unknown, policy: ReturnType<typeof codexWorkerPermissions>): void {
  const decode = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) =>
    ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name]!);
  const environments = Array.isArray(output) ? output.filter(item => item?.role === "user" && item.type === "message")
    .flatMap(item => Array.isArray(item.content) ? item.content : [])
    .filter(item => item?.type === "input_text" && typeof item.text === "string" && item.text.startsWith("<environment_context>")) : [];
  if (environments.length !== 1) throw new Error("effective permission diagnostics are unavailable");
  const text = environments[0].text as string;
  const filesystem = text.match(/<permission_profile type="managed"><file_system type="restricted">([\s\S]*?)<\/file_system><\/permission_profile>/)?.[1];
  if (filesystem === undefined) throw new Error("effective filesystem is not a restricted managed profile");
  const entries = [...filesystem.matchAll(/<entry access="(read|write|deny)"><path>([^<]+)<\/path><\/entry>/g)]
    .map(match => ({ access: match[1], path: decode(match[2]) }));
  for (const match of filesystem.matchAll(/<entry access="(read|write|deny)"><special>([^<]+)<\/special><\/entry>/g)) {
    if (match[1] === "write" && ![":slash_tmp", ":tmpdir"].includes(match[2]))
      throw new Error(`unexpected writable special root: ${match[2]}`);
  }
  for (const [path, access] of Object.entries(policy.profile.filesystem)) {
    if (!entries.some(entry => entry.access === access && samePath(entry.path, path)))
      throw new Error(`effective permissions omit ${access} access to ${path}`);
  }
  // A legacy full-access override or broader rule must not silently replace the policy.
  const expected = new Set(Object.keys(policy.profile.filesystem).map(path => canonicalPath(path).toLowerCase()));
  const cwd = decode(text.match(/<cwd>([^<]+)<\/cwd>/)?.[1] ?? "");
  for (const entry of entries.filter(entry => entry.access === "write")) {
    if (!samePath(entry.path, cwd) && !expected.has(canonicalPath(entry.path).toLowerCase()))
      throw new Error(`unexpected writable root: ${entry.path}`);
  }
}
