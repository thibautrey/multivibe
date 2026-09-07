#Requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Installer)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CODESIGN_PFX_BASE64) -or [string]::IsNullOrWhiteSpace($env:WINDOWS_CODESIGN_PFX_PASSWORD)) {
    throw 'Windows Authenticode signing credentials must be configured before publishing an installer.'
}
$cert = $null
$pfx = Join-Path ([IO.Path]::GetTempPath()) ('multivibe-cert-' + [guid]::NewGuid().ToString('N') + '.pfx')
try {
    [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:WINDOWS_CODESIGN_PFX_BASE64))
    $password = ConvertTo-SecureString $env:WINDOWS_CODESIGN_PFX_PASSWORD -AsPlainText -Force
    $cert = Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\CurrentUser\My -Password $password
    Remove-Item -LiteralPath $pfx -Force
    Remove-Item Env:\WINDOWS_CODESIGN_PFX_BASE64, Env:\WINDOWS_CODESIGN_PFX_PASSWORD
    if (-not $cert.HasPrivateKey -or $cert.NotAfter -le (Get-Date)) { throw 'A valid code signing certificate with a private key is required.' }
    $tool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' | Sort-Object FullName -Descending | Select-Object -First 1
    if ($null -eq $tool) { throw 'Windows SDK signtool is unavailable.' }
    & $tool.FullName sign /fd SHA256 /sha1 $cert.Thumbprint /tr http://timestamp.digicert.com /td SHA256 $Installer
    if ($LASTEXITCODE -ne 0) { throw 'Authenticode signing failed.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $Installer
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate) { throw 'Installer signature or timestamp verification failed.' }
} finally {
    if (Test-Path -LiteralPath $pfx) { Remove-Item -LiteralPath $pfx -Force }
    if ($null -ne $cert) { Remove-Item -LiteralPath ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -DeleteKey -Force }
}
