import { quote } from "./system.js";

/** Commands executed by an owned backend terminal, never the caller's shell. */
export function terminalCommand(command: string, backend: "herdr" | "orca"): { command: string; shell?: string } {
  if (process.platform !== "win32") return { command: backend === "orca" ? `exec sh -c ${quote(command)}` : command };
  const script = `$ErrorActionPreference='Stop'; try { ${command}; if ($null -eq $LASTEXITCODE) { exit 0 }; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_); exit 1 }`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const launch = `pwsh.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  return backend === "orca" ? { command: `${launch}; exit $LASTEXITCODE`, shell: "pwsh.exe" } : { command: launch };
}
