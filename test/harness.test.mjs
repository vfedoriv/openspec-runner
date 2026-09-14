import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Runner } from "../dist/runner.js";
import { configFrom, assignmentsFrom } from "../dist/plan.js";
import { resolveClaudeSettings, claudeArgs } from "../dist/harnesses/claude.js";
import { ClaudeStreamDecoder } from "../dist/harnesses/claude-stream.js";

const uuid = "00000000-0000-4000-8000-000000000000";

test("version 2 configuration and assignments select one registered harness", () => {
  const config = configFrom({
    version: 2,
    defaultAgent: "claude",
    agents: {
      claude: { defaultModel: "sonnet", permissionMode: "dontAsk", allowedTools: [] },
    },
  });
  assert.equal(config.defaultAgent, "claude");
  assert.equal(config.defaultModel, "sonnet");
  const assignments = assignmentsFrom(
    { version: 2, agent: "claude", tasks: { "1.1": { model: "sonnet", effort: "high" } } },
    [{ id: "1.1" }],
  );
  assert.deepEqual(assignments["1.1"], { model: "sonnet", effort: "high", dependsOn: [], parallel: false });
  assert.throws(
    () => assignmentsFrom({ version: 2, agent: "claude", tasks: { "1.1": { agent: "codex" } } }, [{ id: "1.1" }]),
    /Unknown configuration field/,
  );
});

test("Claude settings preserve omitted effort and never inherit a calling model implicitly", () => {
  assert.deepEqual(
    resolveClaudeSettings({ dependsOn: [], parallel: false, model: "sonnet" }, undefined, {
      defaultModel: "sonnet", permissionMode: "dontAsk", allowedTools: [],
    }),
    {
      harness: "claude", model: "sonnet", requestedModel: "sonnet", options: { permissionMode: "dontAsk", allowedTools: [] },
      sources: ["task.model", "claude.cli-default"],
    },
  );
  assert.throws(
    () => resolveClaudeSettings({ dependsOn: [], parallel: false, model: "session" }, undefined, { defaultModel: "sonnet" }),
    /calling-session/,
  );
  assert.deepEqual(
    claudeArgs({ harness: "claude", model: "claude-sonnet-4-6", effort: "high", options: { permissionMode: "dontAsk", allowedTools: [] } }, "/tmp/work", "/tmp/common", uuid),
    ["-p", "--output-format", "stream-json", "--verbose", "--effort", "high", "--model", "claude-sonnet-4-6", "--session-id", uuid, "--permission-mode", "dontAsk", "--add-dir", "/tmp/common"],
  );
});

test("Claude stream decoding handles split chunks, Unicode, unknown events, and final result", () => {
  const events = [];
  const decoder = new ClaudeStreamDecoder((event) => events.push(event));
  const text = JSON.stringify({ type: "system", session_id: uuid, message: "✓" }) + "\n" +
    JSON.stringify({ type: "notice", session_id: uuid, message: "ignored" }) + "\n" +
    JSON.stringify({ type: "result", session_id: uuid, subtype: "success", result: "done" });
  const bytes = Buffer.from(text);
  decoder.feed(bytes.subarray(0, 17));
  decoder.feed(bytes.subarray(17));
  decoder.end();
  assert.equal(decoder.sessionId, uuid);
  assert.equal(decoder.terminal, true);
  assert.equal(events.at(-1).subtype, "success");
  assert.throws(() => new ClaudeStreamDecoder().end(), /without a terminal/);
});

test("a supervised Claude worker records matching stream identity and exit evidence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "openspec claude "));
  const root = join(dir, "repo with spaces");
  const bin = join(dir, "bin");
  mkdirSync(root);
  mkdirSync(bin);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const executable = (path, body) => { writeFileSync(path, `#!/usr/bin/env node\n${body}`); chmodSync(path, 0o755); };
  executable(join(bin, "openspec"), "console.log(JSON.stringify(process.argv[2] === 'status' ? {artifacts:[]} : {state:'ready'}));");
  const module = new URL("../dist/runner.js", import.meta.url).href;
  executable(join(bin, "claude"), `
    const args=process.argv.slice(2), session=args[args.indexOf('--session-id')+1];
    if(args.includes('--version')) console.log('2.1.119 (Claude Code)');
    else if(args.includes('--help')) console.log('-p --output-format stream-json --verbose --model --session-id --resume --permission-mode --allowedTools --add-dir --effort');
    else (async()=>{
      console.log(JSON.stringify({type:'system',session_id:session}));
      const {Runner}=await import(${JSON.stringify(module)}), r=new Runner(process.cwd());
      r.begin('demo','1.1',${JSON.stringify("ATTEMPT")},session);
      r.report('demo','1.1',${JSON.stringify("ATTEMPT")},{attempt:${JSON.stringify("ATTEMPT")},task:'1.1',session,outcome:'blocked',summary:'blocked by fixture',verification:['stream checked']});
      console.log(JSON.stringify({type:'result',session_id:session,subtype:'success',result:'done'}));
    })().catch(e=>{console.error(e);process.exit(9)});
  `);
  git("init", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Runner Test");
  mkdirSync(join(root, "openspec/changes/demo"), { recursive: true });
  writeFileSync(join(root, "openspec/runner.yaml"), "version: 2\ndefaultAgent: claude\nagents:\n  claude:\n    defaultModel: sonnet\n    permissionMode: dontAsk\n    allowedTools: []\nworktrees: git\nterminal: manual\n");
  writeFileSync(join(root, "openspec/changes/demo/tasks.md"), "- [ ] 1.1 Claude task\n");
  writeFileSync(join(root, "openspec/changes/demo/execution.yaml"), "version: 2\nagent: claude\ntasks:\n  \"1.1\": {}\n");
  writeFileSync(join(root, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  const runner = new Runner(root);
  const initial = runner.launch("demo", ["1.1"])[0];
  const script = readFileSync(join(bin, "claude"), "utf8").replaceAll("ATTEMPT", initial.id);
  writeFileSync(join(bin, "claude"), script);
  chmodSync(join(bin, "claude"), 0o755);
  const result = await runner.worker("demo", "1.1", initial.id);
  assert.equal(result.exitCode, 0);
  const saved = runner.read("demo").attempts[0];
  assert.equal(saved.agent, "claude");
  assert.equal(saved.identityConfirmed, true);
  assert.equal(saved.observedSession, saved.expectedSession);
  assert.equal(saved.terminalEvidence.subtype, "success");
  assert.equal(saved.phase, "blocked");
});
