$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
# Remove privileges only from this disposable process; its Node child inherits
# the reduced token. The calling application and account settings are untouched.
# https://learn.microsoft.com/windows/win32/api/securitybaseapi/nf-securitybaseapi-adjusttokenprivileges
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class TestToken {
  [StructLayout(LayoutKind.Sequential)] public struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] public struct Privilege { public uint Count; public Luid Id; public uint Attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid id);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disable, ref Privilege state, uint size, IntPtr previous, IntPtr length);
  public static void Remove(string name) {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      Luid id;
      if (!LookupPrivilegeValue(null, name, out id)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var state = new Privilege { Count=1, Id=id, Attributes=4 };
      if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
      int error = Marshal.GetLastWin32Error();
      if (error != 0 && error != 1300) throw new Win32Exception(error);
    } finally { CloseHandle(token); }
  }
}
'@
[TestToken]::Remove('SeBackupPrivilege')
[TestToken]::Remove('SeRestorePrivilege')
$privileges = & "$env:SystemRoot\System32\whoami.exe" /priv /fo csv /nh
if ($LASTEXITCODE -ne 0 -or $privileges -match '"Se(?:Backup|Restore)Privilege"') { throw 'Could not remove test child privileges' }
$env:OPENSPEC_TEST_STANDARD_CHILD = '1'
$env:NODE_TEST_CONTEXT = $null
& $request.node @($request.args)
exit $LASTEXITCODE
