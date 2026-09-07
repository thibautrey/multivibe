; The native installer owns versions, shortcuts, protocol and scheduled tasks.
; Inno owns only its separate maintenance directory and Apps & Features entry.
#ifndef AppVersion
  #error AppVersion must be supplied
#endif
#ifndef BundleDir
  #error BundleDir must be supplied
#endif
#ifndef OutputDir
  #error OutputDir must be supplied
#endif
[Setup]
AppId={{C6F8A97E-8253-4915-A473-8E153C21D96B}
AppName=MultiVibe Host
AppVersion={#AppVersion}
AppPublisher=MultiVibe
AppPublisherURL=https://github.com/thibautrey/multivibe
AppSupportURL=https://github.com/thibautrey/multivibe/issues
DefaultDirName={localappdata}\Programs\MultiVibe Host Setup
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=multivibe-host_{#AppVersion}_windows_amd64_setup
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
UninstallDisplayName=MultiVibe Host
SetupLogging=yes
[Files]
Source: "{#BundleDir}\*"; DestDir: "{tmp}\payload"; Flags: dontcopy recursesubdirs createallsubdirs
Source: "{#BundleDir}\uninstall.ps1"; DestDir: "{app}"; Flags: ignoreversion
[Code]
function RunNativeScript(ScriptPath: String): Integer;
var ExitCode: Integer;
begin
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ScriptPath + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
    Result := -1
  else
    Result := ExitCode;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  ExtractTemporaryFiles('{tmp}\payload\*');
  if RunNativeScript(ExpandConstant('{tmp}\payload\install.ps1')) <> 0 then
    Result := 'MultiVibe Host setup failed. Check that this is Windows x64 with a supported NVIDIA GPU. The native installer keeps the previous installation on failure.';
end;

function InitializeUninstall(): Boolean;
begin
  Result := RunNativeScript(ExpandConstant('{app}\uninstall.ps1')) = 0;
  if not Result then
    SuppressibleMsgBox('MultiVibe Host could not be removed. The maintenance entry has been kept so you can retry. Application data is preserved.', mbError, MB_OK, IDOK);
end;
