$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion -lt [version]'7.2') { throw 'Windows delegation requires PowerShell 7.2 or newer' }
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
# The native Codex sandbox can execute tools under its own Windows account.
$workerAccounts = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$checkedPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$checkedVolumes = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

function Assert-Path([string]$path) {
    $root = [IO.Path]::GetPathRoot($path)
    if ($checkedVolumes.Add($root)) {
        $drive = [IO.DriveInfo]::new($root)
        if ($drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -ne 'NTFS') {
            throw "Delegated context requires local NTFS: $path"
        }
    }
    while ($path -and $checkedPaths.Add($path)) {
        try {
            $item = Get-Item -Force -LiteralPath $path
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Delegated context path is redirected: $path"
            }
        } catch [System.Management.Automation.ItemNotFoundException] { }
        $path = [IO.Path]::GetDirectoryName($path)
    }
}

function Get-Descriptor($acl) {
    return $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
}

function Set-Descriptor($target, $acl, [string]$descriptor) {
    $acl.SetSecurityDescriptorSddlForm($descriptor, [Security.AccessControl.AccessControlSections]::Access)
    if ($target.directory) {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($target.path), $acl)
    } else {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($target.path), $acl)
    }
}

function Test-AdditiveAcl($target, $acl, [string]$actual) {
    if (!$acl.AreAccessRulesCanonical) { return $false }
    $before = [Security.AccessControl.RawSecurityDescriptor]::new($target.after)
    $after = [Security.AccessControl.RawSecurityDescriptor]::new($actual)
    if ($before.ControlFlags -ne $after.ControlFlags) { return $false }
    $original = [Collections.Generic.List[string]]::new()
    foreach ($ace in $before.DiscretionaryAcl) {
        $bytes = [byte[]]::new($ace.BinaryLength)
        $ace.GetBinaryForm($bytes, 0)
        $original.Add([Convert]::ToBase64String($bytes))
    }
    foreach ($ace in $after.DiscretionaryAcl) {
        $bytes = [byte[]]::new($ace.BinaryLength)
        $ace.GetBinaryForm($bytes, 0)
        if ($original.Remove([Convert]::ToBase64String($bytes))) { continue }
        if ($ace.AceType -notin @('AccessAllowed', 'AccessDenied')) { return $false }
        if ($ace.IsInherited) { continue }
        # Codex can add an inheritable Modify grant at the trusted runtime root.
        if ($target.mask -eq 64 -and $ace.AceType -eq 'AccessAllowed' -and
            ($ace.AccessMask -band (-bnot 0x1301bf)) -eq 0 -and [int]$ace.AceFlags -eq 3) { continue }
        return $false
    }
    return $original.Count -eq 0
}

if ($request.operation -eq 'paths') {
    if ($request.requireStandard) {
        $privileges = & "$env:SystemRoot\System32\whoami.exe" /priv /fo csv /nh
        if ($LASTEXITCODE -ne 0) { throw 'Could not verify Windows token privileges' }
        if ($privileges -match '"Se(?:Backup|Restore)Privilege"') {
            throw 'Windows delegated execution requires a standard session without backup or restore privileges. Reopen the runner without elevation.'
        }
    }
    foreach ($path in $request.paths) { Assert-Path $path }
    @{ sid = $sid.Value } | ConvertTo-Json -Compress
    exit
}

if ($request.sid -and $request.sid -ne $sid.Value) {
    throw 'The active Windows identity differs from the protection journal'
}

if ($request.operation -eq 'apply' -or $request.operation -eq 'verify') {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class RunnerContextAccess {
    [StructLayout(LayoutKind.Sequential)]
    private struct Mapping { public uint Read, Write, Execute, All; }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateToken(SafeAccessTokenHandle token, int level, out SafeAccessTokenHandle copy);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AccessCheck(byte[] descriptor, SafeAccessTokenHandle token,
        uint access, ref Mapping mapping, byte[] privileges, ref uint size, out uint granted, out bool allowed);

    public static bool HasObjectDelete(byte[] descriptor, SafeAccessTokenHandle token) {
        SafeAccessTokenHandle copy;
        if (!DuplicateToken(token, 2, out copy))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        using (copy) {
            var mapping = new Mapping { Read = 0x120089, Write = 0x120116, Execute = 0x1200a0, All = 0x1f01ff };
            var privileges = new byte[1024];
            uint size = (uint)privileges.Length, granted;
            bool allowed;
            if (!AccessCheck(descriptor, copy, 65536, ref mapping, privileges, ref size, out granted, out allowed))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return allowed && (granted & 65536) != 0;
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint sharing,
        System.IntPtr security, uint disposition, uint flags, System.IntPtr template);

    public static int Probe(string path, uint access) {
        using (var handle = CreateFileW(path, access, 7, System.IntPtr.Zero, 3,
                0x02200000, System.IntPtr.Zero)) {
            return handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
        }
    }
}
'@
}

foreach ($path in $request.runtimeFiles) {
    $descriptor = (Get-Acl -LiteralPath $path).GetSecurityDescriptorBinaryForm()
    if (![RunnerContextAccess]::HasObjectDelete($descriptor, $identity.AccessToken)) {
        throw "Runtime files require independent DELETE access before restricting their parent: $path"
    }
}

$entries = foreach ($target in $request.targets) {
    if (($target.mask -band 2) -and $request.operation -ne 'restore') {
        $streams = Get-Item -LiteralPath $target.path -Stream '*' -Force
        if ($streams | Where-Object { $_.Stream -ne ':$DATA' }) {
            throw "Unexpected alternate data stream on pinned context: $($target.path)"
        }
    }
    $acl = Get-Acl -LiteralPath $target.path
    $actual = Get-Descriptor $acl
    if ($request.operation -eq 'plan') {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($workerAccounts,
            [Security.AccessControl.FileSystemRights]$target.mask, 'None', 'None', 'Deny')
        $acl.AddAccessRule($rule)
        @{ before = $actual; after = Get-Descriptor $acl }
        continue
    }

    if ($request.operation -eq 'restore') {
        if ($actual -ceq $target.before) { continue }
        if ($actual -cne $target.after) { throw "ACL changed outside the runner: $($target.path)" }
        Set-Descriptor $target $acl $target.before
        continue
    }

    if ($request.operation -eq 'apply' -and $actual -ceq $target.before -and $actual -cne $target.after) {
        Set-Descriptor $target $acl $target.after
        $acl = Get-Acl -LiteralPath $target.path
        $actual = Get-Descriptor $acl
    }
    if ($actual -cne $target.after -and !(Test-AdditiveAcl $target $acl $actual)) {
        throw "Unexpected ACL on pinned context: $($target.path)"
    }
    $denied = 0
    foreach ($rule in $acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
        if ($rule.IdentityReference -eq $workerAccounts -and $rule.AccessControlType -eq 'Deny' -and
            $rule.InheritanceFlags -eq 'None' -and $rule.PropagationFlags -eq 'None') {
            $denied = $denied -bor [int]$rule.FileSystemRights
        }
    }
    if (($denied -band $target.mask) -ne $target.mask) { throw "Pinned context ACL omits worker accounts: $($target.path)" }
    foreach ($right in @(2, 4, 16, 64, 256, 65536)) {
        if (($target.mask -band $right) -and [RunnerContextAccess]::Probe($target.path, $right) -ne 5) {
            throw "Windows did not prove denial of access $right on $($target.path)"
        }
    }
}
@{ sid = $sid.Value; entries = @($entries) } | ConvertTo-Json -Depth 5 -Compress
