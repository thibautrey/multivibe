#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$setup = Join-Path $env:RUNNER_TEMP 'innosetup-6.4.3.exe'
Invoke-WebRequest 'https://github.com/jrsoftware/issrc/releases/download/is-6_4_3/innosetup-6.4.3.exe' -OutFile $setup
if ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'f3c42116542c4cc57263c5ba6c4feabfc49fe771f2f98a79d2f7628b8762723b') { throw 'Inno Setup checksum mismatch.' }
$process = Start-Process -FilePath $setup -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-' -PassThru -Wait
if ($process.ExitCode -ne 0) { throw 'Inno Setup installation failed.' }
Remove-Item -LiteralPath $setup -Force
