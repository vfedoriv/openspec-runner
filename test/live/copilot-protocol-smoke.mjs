import { CopilotClient, RuntimeConnection } from "@microsoft/copilot-sdk";
import { resolveCommand } from "../../dist/platform-command.js";

// No session, prompt, or model call: only initialize the installed runtime.
const command = resolveCommand({ executable: "copilot", args: [], cwd: process.cwd() });
if (command.args.length) throw new Error("Protocol probe requires a native executable");
const client = new CopilotClient({ mode: "coding-agent", runtime: RuntimeConnection.forSpawnedStdio({ path: command.executable, workingDirectory: process.cwd() }) });
const result = { executable: command.executable, inferenceStarted: false };
try {
  await client.start();
  const status = await client.getStatus();
  result.runtime = { version: status.version, protocolVersion: status.protocolVersion };
  result.status = "PASS";
} catch (error) {
  result.status = "BLOCKED";
  // Never print provider diagnostics: retain only the fixed protocol envelope.
  result.reason = String(error.message).match(/SDK protocol version mismatch: SDK supports versions \d+-\d+, but server reports version \d+\./)?.[0] ?? "Runtime initialization failed; detailed provider diagnostics withheld";
} finally {
  const errors = await client.stop();
  result.shutdownErrors = errors.length;
}
console.log(JSON.stringify(result, null, 2));
if (result.status !== "PASS" || result.shutdownErrors) process.exitCode = 1;
