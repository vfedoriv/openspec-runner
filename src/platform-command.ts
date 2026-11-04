import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, resolve } from "node:path";

export interface ResolvedCommand { executable: string; args: string[]; env: NodeJS.ProcessEnv }

export function resolveCommand(input: { executable: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }): ResolvedCommand {
  const env = { ...(input.env ?? process.env) };
  if (process.platform !== "win32") return { executable: input.executable, args: input.args, env };
  const path = env.PATH ?? env.Path ?? "";
  // Node picks the first case-insensitive environment key on Windows.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.Path = path;
  const explicit = isAbsolute(input.executable) || /[\\/]/.test(input.executable);
  const directories = explicit ? [input.cwd] : path.split(delimiter).map(p => p.replace(/^"|"$/g, ""));
  const suffixes = extname(input.executable) ? [""] : [".exe", ".com", ".cmd", ""];
  let file: string | undefined;
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = resolve(directory || input.cwd, input.executable + suffix);
      if (existsSync(candidate) && statSync(candidate).isFile()) { file = candidate; break; }
    }
    if (file) break;
  }
  if (!file) throw new Error(`Executable not found on this Windows host: ${input.executable}`);
  if (/\.(exe|com)$/i.test(file)) return { executable: file, args: input.args, env };
  const content = readFileSync(file, "utf8");
  if (extname(file).toLowerCase() === ".cmd") {
    const editor = content.match(/"%~dp0([^"\r\n]+Code(?: - Insiders)?\.exe)"\s+"%~dp0([^"\r\n]+cli\.js)"/i);
    if (editor) {
      const invocation = `"%~dp0${editor[1]}" "%~dp0${editor[2]}" %*`;
      const allowed = new Set(["@echo off", "setlocal", "set vscode_dev=", "set electron_run_as_node=1", invocation.toLowerCase(), "if %errorlevel% neq 0 exit /b %errorlevel%", "endlocal"]);
      if (!content.split(/\r?\n/).every(line => !line.trim() || allowed.has(line.trim().toLowerCase())))
        throw new Error(`Unsupported Windows command wrapper ${file}; configure its native executable or Node script entry point`);
      const executable = resolve(dirname(file), editor[1]), script = resolve(dirname(file), editor[2]);
      if (!existsSync(executable) || !existsSync(script)) throw new Error(`VS Code wrapper references missing entry points: ${file}`);
      return { executable, args: [script, ...input.args], env: { ...env, ELECTRON_RUN_AS_NODE: "1", VSCODE_DEV: "" } };
    }
    const entryMatch = content.match(/"((?:%~dp0|%dp0%)[\\/]?[^"\r\n]+\.(?:cjs|mjs|js))"/i);
    if (entryMatch) {
      const script = entryMatch[1];
      const normalize = (source: string) => source.trim().replace(/\s+/g, " ").toLowerCase();
      const simple = `@echo off\nnode "${script}" %*`;
      const pnpm = `@SETLOCAL\n@IF EXIST "%~dp0\\node.exe" (\n "%~dp0\\node.exe" "${script}" %*\n) ELSE (\n @SET PATHEXT=%PATHEXT:;.JS;=;%\n node "${script}" %*\n)`;
      const npm = `@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\nIF EXIST "%dp0%\\node.exe" (\n SET "_prog=%dp0%\\node.exe"\n) ELSE (\n SET "_prog=node"\n SET PATHEXT=%PATHEXT:;.JS;=;%\n)\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "${script}" %*`;
      const known = [simple, pnpm, npm].some(template => normalize(template) === normalize(content));
      const entry = resolve(dirname(file), script.replace(/^%(?:~dp0|dp0%)[\\/]?/i, ""));
      if (known && existsSync(entry)) {
        const adjacentNode = resolve(dirname(file), "node.exe");
        const node = normalize(content) !== normalize(simple) && existsSync(adjacentNode)
          ? adjacentNode : resolveCommand({ executable: "node.exe", args: [], cwd: input.cwd, env }).executable;
        return { executable: node, args: [entry, ...input.args], env };
      }
    }
    throw new Error(`Unsupported Windows command wrapper ${file}; configure its native executable or Node script entry point`);
  }
  if (/\.(?:cjs|mjs|js)$/i.test(file) || /^#![^\r\n]*\bnode\b/.test(content))
    return { executable: process.execPath, args: [file, ...input.args], env };
  throw new Error(`Unsupported Windows executable format: ${file}`);
}

export function renderArgument(value: string, shell: "powershell" | "posix"): string {
  return shell === "powershell" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
}
export function renderCommand(args: string[], shell: "powershell" | "posix"): string {
  return (shell === "powershell" ? "& " : "") + args.map(arg => renderArgument(arg, shell)).join(" ");
}
