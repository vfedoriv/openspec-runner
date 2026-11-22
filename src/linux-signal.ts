import { execFileSync } from "node:child_process";
import type { LinuxProvenance, ProcessIdentity } from "./platform-process.js";

// Kept in TypeScript so tsc and the ordinary dist package include the helper.
// -I -S isolates Python from user site packages and working-directory imports.
const pidfdHelper = String.raw`
import json, os, select, signal, sys

def identity(pid):
    with open('/proc/%d/stat' % pid) as stream:
        text = stream.read()
    return text[text.rfind(')') + 2:].split()[19]

def check_view(expected):
    namespace = os.readlink('/proc/self/ns/pid')
    if os.readlink('/proc/self') != str(os.getpid()):
        raise RuntimeError('namespace')
    with open('/proc/self/status') as stream:
        status = stream.read().splitlines()
    for name in ('Pid', 'Tgid', 'NSpid', 'NStgid'):
        rows = [line.split(':', 1)[1].split() for line in status if line.startswith(name + ':')]
        if rows != [[str(os.getpid())]]:
            raise RuntimeError('namespace')
    with open('/etc/machine-id') as stream:
        machine = stream.read().strip()
    with open('/proc/sys/kernel/random/boot_id') as stream:
        boot = stream.read().strip()
    if expected.get('version') != 1 or expected.get('platform') != 'linux' or expected.get('machine') != machine or expected.get('boot') != boot or expected.get('namespace') != namespace:
        raise RuntimeError('namespace')

def group_stopped(pid):
    path = '/proc/%d/task' % pid
    names = sorted(os.listdir(path))
    if not names:
        raise RuntimeError('observation')
    for name in names:
        with open(path + '/' + name + '/stat') as stream:
            text = stream.read()
        state = text[text.rfind(')') + 2:].split()[0]
        if state not in ('T', 'Z'):
            raise RuntimeError('resumed')
    if names != sorted(os.listdir(path)):
        raise RuntimeError('observation')

try:
    request = json.load(sys.stdin)
    check_view(request['provenance'])
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise RuntimeError('unsupported')
    pid = os.getpid() if request['operation'] == 'probe' else request['identity']['pid']
    fd = os.pidfd_open(pid, 0)
    try:
        check_view(request['provenance'])
        if request['operation'] == 'probe':
            signal.pidfd_send_signal(fd, 0, None, 0)
            result = 'ready'
        else:
            if identity(pid) != request['identity']['createdAt']:
                raise RuntimeError('identity')
            poller = select.poll()
            poller.register(fd, select.POLLIN)
            if poller.poll(0):
                result = 'gone'
            else:
                operation = request['operation']
                if operation not in ('SIGSTOP', 'SIGCONT', 'SIGKILL'):
                    raise RuntimeError('unsupported')
                if operation != 'SIGSTOP':
                    group_stopped(pid)
                signal.pidfd_send_signal(fd, getattr(signal, operation), None, 0)
                result = 'sent'
    finally:
        os.close(fd)
    print(json.dumps({'result': result}))
except Exception:
    print(json.dumps({'error': 'uncertain'}))
    sys.exit(1)
`;
const diagnostic = "Linux cancellation requires existing Python 3 with pidfd support and a coherent procfs PID view; identity or signal observation is uncertain";

function invoke(operation: string, provenance: LinuxProvenance, identity?: ProcessIdentity, timeoutMs = 1000): string {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error(diagnostic);
  try {
    const output = execFileSync("python3", ["-I", "-S", "-c", pidfdHelper], {
      input: JSON.stringify({ operation, provenance, identity }),
      encoding: "utf8",
      timeout: Math.min(1000, Math.floor(timeoutMs)),
      maxBuffer: 4096,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const result = JSON.parse(output).result;
    if (!["ready", "sent", "gone"].includes(result)) throw new Error(diagnostic);
    return result;
  } catch { throw new Error(diagnostic); }
}
export function probeLinuxSignals(provenance: LinuxProvenance, timeoutMs = 1000): void {
  if (invoke("probe", provenance, undefined, timeoutMs) !== "ready") throw new Error(diagnostic);
}
export function signalLinuxIdentity(identity: ProcessIdentity, provenance: LinuxProvenance, signal: "SIGSTOP" | "SIGCONT" | "SIGKILL", timeoutMs = 1000): void {
  invoke(signal, provenance, identity, timeoutMs);
}
