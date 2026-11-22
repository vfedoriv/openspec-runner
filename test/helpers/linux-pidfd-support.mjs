import { spawn } from "node:child_process";
import { once } from "node:events";
import { linuxProvenance, observeProcess } from "../../dist/platform-process.js";
import { probeLinuxSignals, signalLinuxIdentity } from "../../dist/linux-signal.js";

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("pidfd capability probe deadline")), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

async function capability() {
  if (process.platform !== "linux") return "Requires Linux pidfd cancellation";
  let child;
  try {
    const provenance = linuxProvenance();
    if (!provenance) throw new Error("incoherent or unreadable procfs PID view");
    probeLinuxSignals(provenance);
    child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000);process.stdout.write('ready')"], { stdio: ["ignore", "pipe", "ignore"] });
    const closed = once(child, "close");
    await bounded(Promise.race([once(child.stdout, "data"), closed.then(() => {
      throw new Error("sentinel exited before readiness");
    })]));
    const identity = observeProcess(child.pid);
    if (!identity) throw new Error("missing sentinel identity");
    signalLinuxIdentity(identity, provenance, "SIGSTOP");
    signalLinuxIdentity(identity, provenance, "SIGCONT");
    signalLinuxIdentity(identity, provenance, "SIGSTOP");
    signalLinuxIdentity(identity, provenance, "SIGKILL");
    await bounded(closed);
    return false;
  } catch {
    return "Requires functional existing Python 3, Linux pidfd SIGSTOP/SIGCONT/SIGKILL and coherent procfs; native cancellation not verified on this host";
  } finally {
    // Only this capability probe's own disposable child; product never falls back.
    try { child?.kill("SIGKILL"); } catch {}
  }
}
export const linuxPidfdOptions = { skip: await capability() };
