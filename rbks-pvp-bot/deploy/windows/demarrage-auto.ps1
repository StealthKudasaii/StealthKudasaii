# -----------------------------------------------------------------------------
#  RBKS PVP - demarrage automatique du bot avec Windows (tache planifiee).
#  Utilise par demarrage-auto.bat. Option -Remove pour desinstaller.
#  Fichier volontairement en ASCII (compatibilite Windows PowerShell 5.1).
# -----------------------------------------------------------------------------
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$TaskName = 'RBKS PVP Bot'
$AppDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Script = Join-Path $PSScriptRoot 'rbks-vps.ps1'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Remove) {
  if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*dist\index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host 'Demarrage automatique supprime et bot arrete.'
  } else {
    Write-Host 'Aucun demarrage automatique installe.'
  }
  exit 0
}

# Le bot ne doit jamais tourner deux fois : la fenetre lancer-bot.bat doit etre fermee.
$running = $null
try { $running = [System.Threading.Mutex]::OpenExisting('Global\RBKS-PVP-Bot') } catch { $running = $null }
if ($running -and -not $existing) {
  Write-Host 'Le bot tourne deja dans une fenetre (lancer-bot.bat). Ferme cette fenetre puis relance ce fichier.'
  exit 1
}

foreach ($cmd in @('node', 'npm', 'git')) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Write-Host "$cmd est introuvable : installe-le d'abord (voir docs\DEPLOIEMENT.md)."; exit 1 }
}
if (-not (Test-Path (Join-Path $AppDir 'dist\index.js'))) {
  Write-Host 'Lance d''abord lancer-bot.bat une fois (installation, .env, compilation), puis ferme sa fenetre.'
  exit 1
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`" -Service" -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
# ExecutionTimeLimit = 0 : sans cela, Windows arrete la tache au bout de 3 jours.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host ''
Write-Host 'OK : le bot tourne maintenant en arriere-plan et redemarrera avec le VPS.'
Write-Host 'Il se met a jour tout seul a chaque push sur GitHub (verification chaque minute).'
Write-Host ''
Write-Host "Journal des mises a jour : $AppDir\data\vps.log"
Write-Host "Journal du bot           : $AppDir\data\bot.log  et  bot-error.log"
