<#
  Notepad Hub 4 (preview): установка РЯДОМ с Notepad Hub 3.x.
  - Ставит приложение в %LOCALAPPDATA%\NotepadHub4\app. Папка данных (%LOCALAPPDATA%\NotepadHub\data-v3) не копируется и не удаляется.
  - Создаёт ярлыки "Notepad Hub 4" на рабочем столе и в меню Пуск. Ярлыки и файлы Notepad Hub 3 не меняются.
  - Контекстное меню Проводника ("Открыть в Notepad Hub 4") добавляется только с ключом -ContextMenu.
  - Ассоциацию .txt скрипт НЕ меняет (это системная настройка: делайте её сами в «Параметры → Приложения по умолчанию»).
  - Две версии не должны быть открыты одновременно на одних данных: v4 при запуске это проверяет.

  Просмотр без изменений:   .\Install-NotepadHub4.ps1 -WhatIf
  Установка:                .\Install-NotepadHub4.ps1
  Удаление программы:       .\Install-NotepadHub4.ps1 -Uninstall      (заметки остаются на месте)
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Uninstall,
    [switch]$ContextMenu,
    [switch]$DesktopOnly,       # только ярлык на рабочем столе, без меню Пуск
    [string]$Source
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$hubRoot = Join-Path $env:LOCALAPPDATA 'NotepadHub4'
$appDir = Join-Path $hubRoot 'app'
$backupDir = Join-Path $hubRoot 'app-backups'
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$links = @((Join-Path $desktop 'Notepad Hub 4.lnk'), (Join-Path $startMenu 'Notepad Hub 4.lnk'))
$createLinks = if ($DesktopOnly) { @($links[0]) } else { $links }
$shellKey = 'HKCU:\Software\Classes\*\shell\NotepadHub4'

if (@(Get-Process -Name 'NotepadHub4' -ErrorAction SilentlyContinue).Count -gt 0) {
    throw 'Notepad Hub 4 сейчас запущен. Закройте окно и повторите.'
}

if ($Uninstall) {
    foreach ($l in $links) { if (Test-Path -LiteralPath $l) { if ($PSCmdlet.ShouldProcess($l, 'Удалить ярлык')) { Remove-Item -LiteralPath $l -Force } } }
    if (Test-Path $shellKey) { if ($PSCmdlet.ShouldProcess($shellKey, 'Удалить пункт контекстного меню')) { Remove-Item -Path $shellKey -Recurse -Force } }
    if (Test-Path -LiteralPath $appDir) { if ($PSCmdlet.ShouldProcess($appDir, 'Удалить программу')) { Remove-Item -LiteralPath $appDir -Recurse -Force } }
    Write-Host 'Программа удалена. Заметки и резервные копии не тронуты.' -ForegroundColor Green
    return
}

$publish = $Source
$temp = $null
if (-not $publish) {
    $temp = Join-Path $env:TEMP ('nh4-install-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    Write-Host 'Сборка (Release)…'
    & dotnet publish (Join-Path $repo 'src\NotepadHub.Host') -c Release -o $temp --nologo -v q
    if ($LASTEXITCODE -ne 0) { throw 'Сборка не удалась. Ничего не установлено.' }
    $publish = $temp
}
if (-not (Test-Path (Join-Path $publish 'NotepadHub4.exe')) -or -not (Test-Path (Join-Path $publish 'ui\index.html'))) {
    throw "В '$publish' нет NotepadHub4.exe или папки ui. Ничего не установлено."
}

try {
    if ($PSCmdlet.ShouldProcess($appDir, 'Установить Notepad Hub 4')) {
        New-Item -ItemType Directory -Path $hubRoot, $backupDir -Force | Out-Null
        if (Test-Path -LiteralPath $appDir) {
            Copy-Item -LiteralPath $appDir -Destination (Join-Path $backupDir ('app_' + (Get-Date -Format 'yyyyMMdd_HHmmss'))) -Recurse -Force
            Remove-Item -LiteralPath $appDir -Recurse -Force
        }
        New-Item -ItemType Directory -Path $appDir -Force | Out-Null
        Copy-Item -Path (Join-Path $publish '*') -Destination $appDir -Recurse -Force

        $exe = Join-Path $appDir 'NotepadHub4.exe'
        $wsh = New-Object -ComObject WScript.Shell
        foreach ($l in $createLinks) {
            $sc = $wsh.CreateShortcut($l)
            $sc.TargetPath = $exe
            $sc.WorkingDirectory = $appDir
            $sc.IconLocation = $exe + ',0'
            $sc.Description = 'Notepad Hub 4 (предварительная версия)'
            $sc.Save()
            $check = $wsh.CreateShortcut($l)
            if (-not [string]::Equals($check.TargetPath, $exe, [StringComparison]::OrdinalIgnoreCase)) { throw "Ярлык создан неверно: $l" }
        }
        if ($ContextMenu) {
            New-Item -Path (Join-Path $shellKey 'command') -Force | Out-Null
            Set-Item -Path $shellKey -Value 'Открыть в Notepad Hub 4'
            Set-ItemProperty -Path $shellKey -Name 'Icon' -Value $exe -Force
            Set-Item -Path (Join-Path $shellKey 'command') -Value ('"' + $exe + '" "%1"')
        }
        Write-Host 'Notepad Hub 4 установлен рядом с версией 3.' -ForegroundColor Green
        Write-Host "Программа: $exe"
        Write-Host 'Перед запуском закройте Notepad Hub 3: обе версии используют одни заметки.'
    }
}
finally {
    if ($temp -and $temp -match 'nh4-install-[0-9a-f]{8}$' -and (Test-Path -LiteralPath $temp)) { [IO.Directory]::Delete($temp, $true) }
}
