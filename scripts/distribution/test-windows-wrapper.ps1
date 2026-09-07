# Run only on a disposable Windows CI runner. Exercises the real Inno installer
# with a tiny stand-in for the native bundle; GPU integration is a separate test.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Compiler)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$arp = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{C6F8A97E-8253-4915-A473-8E153C21D96B}_is1'
$maintenance = Join-Path $env:LOCALAPPDATA 'Programs\MultiVibe Host Setup'
if ((Test-Path -LiteralPath $arp) -or (Test-Path -LiteralPath $maintenance) -or (Test-Path 'HKCU:\Software\MultiVibe Host')) { throw 'A clean disposable runner is required.' }
$work = Join-Path $env:RUNNER_TEMP ('multivibe-wrapper-test-' + [guid]::NewGuid().ToString('N'))
$bundle = Join-Path $work 'bundle'
$out = Join-Path $work 'output'
New-Item -ItemType Directory -Path $bundle,$out -Force | Out-Null
try {
    # A failure in the native installer must not produce an installed wrapper.
    Set-Content (Join-Path $bundle 'install.ps1') 'exit 23'
    Set-Content (Join-Path $bundle 'uninstall.ps1') 'exit 0'
    & $Compiler "/DAppVersion=0.0.1" "/DBundleDir=$bundle" "/DOutputDir=$out" (Join-Path $repo 'packaging/windows/multivibe-host.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Compiler failed.' }
    $exe = Join-Path $out 'multivibe-host_0.0.1_windows_amd64_setup.exe'
    $run = Start-Process $exe -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-' -Wait -PassThru
    if ($run.ExitCode -eq 0 -or (Test-Path -LiteralPath $arp)) { throw 'Native failure was not propagated.' }
    Remove-Item -LiteralPath $exe
    # A successful install is discoverable and supports unattended uninstall.
    Set-Content (Join-Path $bundle 'install.ps1') 'exit 0'
    & $Compiler "/DAppVersion=0.0.1" "/DBundleDir=$bundle" "/DOutputDir=$out" (Join-Path $repo 'packaging/windows/multivibe-host.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Compiler failed.' }
    $run = Start-Process $exe -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-' -Wait -PassThru
    if ($run.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $arp)) { throw 'Unattended install failed.' }
    if ((Get-ItemProperty -LiteralPath $arp).DisplayVersion -ne '0.0.1') { throw 'Incorrect Apps & Features version.' }
    # An uninstaller failure must preserve the registration so users can retry.
    Set-Content (Join-Path $maintenance 'uninstall.ps1') 'exit 23'
    $uninstaller = Join-Path $maintenance 'unins000.exe'
    $run = Start-Process $uninstaller -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -Wait -PassThru
    if (-not (Test-Path -LiteralPath $arp)) { throw 'Failed uninstall removed the recovery entry.' }
    Set-Content (Join-Path $maintenance 'uninstall.ps1') 'exit 0'
    $run = Start-Process $uninstaller -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -Wait -PassThru
    if ($run.ExitCode -ne 0 -or (Test-Path -LiteralPath $arp)) { throw 'Unattended uninstall failed.' }
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force
}
