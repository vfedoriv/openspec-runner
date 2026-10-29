import { attempt, run, runRaw } from "./system.js";
import type { Terminal } from "./adapters.js";

function requireContext() {
  if (process.env.HERDR_ENV !== "1") throw new Error("Reconnect to the saved Herdr session; HERDR_ENV=1 is required");
}
export function herdrCall(root: string, args: string[]): any {
  requireContext();
  const output = run("herdr", args, root, 10000);
  // pane run acknowledges submission through its exit status in current CLIs.
  if (!output && args[0] === "pane" && args[1] === "run") return { ok: true };
  const value = JSON.parse(output);
  if (value.error || !value.result) throw new Error(`Herdr error: ${JSON.stringify(value)}`);
  return value.result;
}
export function herdrScrollback(root: string, pane: string): { text: string } {
  requireContext();
  return { text: runRaw("herdr", ["pane", "read", pane, "--lines", "2000"], root, 10000) };
}
export function herdrProcessInfo(root: string, pane: string): any {
  requireContext();
  const help = attempt(() => run("herdr", ["pane", "process-info", "--help"], root, 10000));
  return herdrCall(root, ["pane", "process-info", ...(help?.includes("--pane") ? ["--pane", pane] : [pane])]).process_info;
}
export function focusHerdrPane(root: string, terminal: Terminal): any {
  try { herdrCall(root, ["agent", "get", terminal.pane!]); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes("agent_not_found")) throw error;
    const pane = herdrCall(root, ["pane", "get", terminal.pane!]).pane;
    const matches = (value: any) => value?.pane_id === terminal.pane && value.terminal_id === terminal.terminal && value.workspace_id === terminal.workspace;
    if (!terminal.owned || !terminal.terminal || !terminal.workspace || !matches(pane) || !pane.tab_id)
      throw new Error("Saved Herdr pane identity changed; inspect ownership before focusing");
    const tab = herdrCall(root, ["tab", "get", pane.tab_id]).tab;
    if (tab?.tab_id !== pane.tab_id || tab.workspace_id !== terminal.workspace || tab.pane_count !== 1)
      throw new Error("Cannot focus the exact worker pane in a split or changed tab; inspect it manually");
    herdrCall(root, ["workspace", "focus", terminal.workspace]);
    herdrCall(root, ["tab", "focus", pane.tab_id]);
    const after = herdrCall(root, ["pane", "get", terminal.pane!]).pane;
    if (!matches(after) || after.focused === false) throw new Error("Herdr did not acknowledge the exact worker pane focus");
    return { backend: "herdr", pane: terminal.pane, workspace: terminal.workspace };
  }
  return herdrCall(root, ["agent", "focus", terminal.pane!]);
}
