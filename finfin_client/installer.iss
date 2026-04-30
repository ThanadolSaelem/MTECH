; MTECH ระบบบัญชี — Inno Setup Script
; Build: ISCC.exe installer.iss
; Output: installer\MTECH_Setup.exe

#define AppName    "MTECH ระบบบัญชี"
#define AppVersion "1.0.0"
#define AppExe     "FinFin.exe"

[Setup]
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=MTECH
DefaultDirName={localappdata}\Programs\MTECH
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=installer
OutputBaseFilename=MTECH_Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

; ไม่ต้องการสิทธิ์ Admin — ติดตั้งใน AppData\Local ของผู้ใช้คนเดียว
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
ShowLanguageDialog=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "สร้าง Shortcut บน Desktop"; GroupDescription: "เพิ่มเติม:"

[Files]
Source: "dist\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}";           Filename: "{app}\{#AppExe}"
Name: "{group}\ถอนการติดตั้ง MTECH"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}";     Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; \
  Description: "เปิด {#AppName} ทันที"; \
  Flags: nowait postinstall skipifsilent
