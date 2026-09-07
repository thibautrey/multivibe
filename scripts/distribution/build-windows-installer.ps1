#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][string]$Version,
    [Parameter(Mandatory=$true)][string]$Output,
    [Parameter(Mandatory=$true)][string]$Compiler
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'A stable version is required.' }
if ($env:OS -ne 'Windows_NT') { throw 'Build on Windows x64.' }
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$Archive = (Resolve-Path -LiteralPath $Archive).Path
if ([IO.Path]::GetFileName($Archive) -ne "multivibe-host_${Version}_windows_amd64.zip") { throw 'Archive name does not match the version.' }
$reportText = & node (Join-Path $repo 'scripts/provider-host/verify-provider-host.mjs') $Archive
if ($LASTEXITCODE -ne 0) { throw 'Native archive verification failed.' }
$report = ($reportText -join "`n") | ConvertFrom-Json
if (-not $report.verified -or -not $report.releaseReady -or $report.version -ne $Version -or $report.platform -ne 'windows' -or $report.architecture -ne 'amd64') { throw 'Not a release-ready Windows bundle.' }
$Output = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Path $Output -Force | Out-Null
$work = Join-Path ([IO.Path]::GetTempPath()) ('multivibe-setup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    Expand-Archive -LiteralPath $Archive -DestinationPath $work
    $roots = @(Get-ChildItem -LiteralPath $work -Directory)
    if ($roots.Count -ne 1) { throw 'Expected one bundle root.' }
    $bundle = $roots[0].FullName
    foreach ($file in @('install.ps1', 'uninstall.ps1', 'manifest.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $bundle $file) -PathType Leaf)) { throw "Missing $file" }
    }
    $destination = Join-Path $Output "multivibe-host_${Version}_windows_amd64_setup.exe"
    if (Test-Path -LiteralPath $destination) { throw 'Refusing to overwrite an installer.' }
    & $Compiler "/DAppVersion=$Version" "/DBundleDir=$bundle" "/DOutputDir=$Output" (Join-Path $repo 'packaging/windows/multivibe-host.iss')
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $destination)) { throw 'Inno Setup compilation failed.' }
    if ((Get-Item -LiteralPath $destination).Length -ge 2GB) { throw 'Installer exceeds GitHub asset limit; reduce the bundled runtime before distribution.' }
    Write-Output $destination
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force
}
