# -----------------------------------------------------------------------------
#  RBKS PVP - lancement du bot sur Windows avec mise a jour automatique
#
#  Lance par lancer-bot.bat (fenetre visible) ou par la tache planifiee
#  "RBKS PVP Bot" au demarrage du VPS (option -Service, sans fenetre).
#
#  - Lance le bot et le relance s'il s'arrete.
#  - Toutes les minutes, regarde s'il y a un nouveau commit sur GitHub :
#    recupere le code, reinstalle les dependances seulement si elles ont change,
#    compile a cote de la version en service, redemarre, verifie que le bot se
#    reconnecte a Discord. En cas d'echec : retour a la version precedente et ce
#    commit n'est plus retente.
#  Fichier volontairement en ASCII (compatibilite Windows PowerShell 5.1).
# -----------------------------------------------------------------------------
param([switch]$Service)

$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $AppDir

function Read-EnvValue([string]$name, [string]$default) {
  $file = Join-Path $AppDir '.env'
  if (Test-Path $file) {
    $line = Get-Content $file | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -Last 1
    if ($line) {
      $v = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
      if ($v) { return $v }
    }
  }
  return $default
}

$DataDir = Read-EnvValue 'DATA_DIR' './data'
if (-not [IO.Path]::IsPathRooted($DataDir)) { $DataDir = Join-Path $AppDir $DataDir }
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$WebPort = Read-EnvValue 'WEB_PORT' '3000'
$WebEnabled = (Read-EnvValue 'WEB_ENABLED' 'true') -ne 'false'
$LogFile = Join-Path $DataDir 'vps.log'
$BadFile = Join-Path $DataDir 'deploy-bad-commit'

function Log([string]$msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  Add-Content -Path $LogFile -Value $line
}

# Une seule instance a la fois (fenetre ET tache planifiee ne doivent jamais tourner ensemble).
$mutex = New-Object System.Threading.Mutex($false, 'Global\RBKS-PVP-Bot')
try { $acquired = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
if (-not $acquired) {
  Write-Host 'Le bot tourne deja sur ce VPS (fenetre ou demarrage automatique). Rien a faire.'
  exit 3
}

# git avec safe.directory : la tache planifiee tourne sous le compte SYSTEM.
function Git-Out {
  $out = & git -c safe.directory=* @args
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') a echoue (code $LASTEXITCODE)" }
  return $out
}

$UpdatesEnabled = $true
$isRepo = $false
try { & git -c safe.directory=* rev-parse --is-inside-work-tree *> $null; $isRepo = ($LASTEXITCODE -eq 0) } catch { $isRepo = $false }
if (-not $isRepo) {
  $UpdatesEnabled = $false
  Log 'Ce dossier n''est pas un clone git (telechargement ZIP ?) : mises a jour automatiques desactivees.'
} else {
  $Branch = (Git-Out rev-parse --abbrev-ref HEAD | Select-Object -First 1).Trim()
}

$script:Bot = $null

function Start-Bot {
  $p = @{ FilePath = 'node'; ArgumentList = 'dist\index.js'; WorkingDirectory = $AppDir; PassThru = $true }
  if ($Service) {
    $p.WindowStyle = 'Hidden'
    $p.RedirectStandardOutput = Join-Path $DataDir 'bot.log'
    $p.RedirectStandardError = Join-Path $DataDir 'bot-error.log'
  } else {
    $p.NoNewWindow = $true
  }
  $script:Bot = Start-Process @p
  Log "Bot demarre (processus $($script:Bot.Id))."
}

function Stop-Bot {
  if ($script:Bot -and -not $script:Bot.HasExited) {
    # SQLite (mode WAL) supporte un arret brutal sans perte de donnees.
    Stop-Process -Id $script:Bot.Id -Force -ErrorAction SilentlyContinue
    $script:Bot.WaitForExit(15000) | Out-Null
  }
}

function Wait-Healthy {
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 3
    if ($script:Bot.HasExited) { return $false }
    if (-not $WebEnabled) {
      if ($i -ge 8) { return $true } else { continue }
    }
    try {
      $h = Invoke-RestMethod -Uri "http://127.0.0.1:$WebPort/health" -TimeoutSec 3 -UseBasicParsing
      if ($h.discord -eq $true) { return $true }
    } catch { }
  }
  return $false
}

function Write-Deploy([string]$status, [string]$commit, [string]$previous, [string]$message, [string]$reason) {
  $data = [ordered]@{ status = $status; commit = $commit; previous = $previous; message = $message; at = (Get-Date).ToUniversalTime().ToString('o'); announced = $false }
  if ($reason) { $data.reason = $reason }
  $json = $data | ConvertTo-Json
  # UTF-8 sans BOM (sinon Node ne peut pas lire le fichier).
  [IO.File]::WriteAllText((Join-Path $DataDir 'deploy.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-Npm([string[]]$npmArgs) {
  & npm @npmArgs
  return ($LASTEXITCODE -eq 0)
}

$script:LastSkipLog = ''

function Check-Update {
  if (-not $UpdatesEnabled) { return }
  Git-Out fetch --quiet origin $Branch | Out-Null
  $old = (Git-Out rev-parse HEAD | Select-Object -First 1).Trim()
  $new = (Git-Out rev-parse "origin/$Branch" | Select-Object -First 1).Trim()
  if ($old -eq $new) { return }
  if ((Test-Path $BadFile) -and ((Get-Content $BadFile -Raw).Trim() -eq $new)) { return }

  $dirty = Git-Out status --porcelain --untracked-files=no
  if ($dirty) {
    if ($script:LastSkipLog -ne $new) { Log 'Fichiers du code modifies directement sur le VPS : mise a jour ignoree (annule avec : git checkout -- .).'; $script:LastSkipLog = $new }
    return
  }
  & git -c safe.directory=* merge-base --is-ancestor $old $new
  if ($LASTEXITCODE -ne 0) {
    if ($script:LastSkipLog -ne $new) { Log "Historique GitHub reecrit (force-push) : mise a jour ignoree. Aligne a la main : git reset --hard origin/$Branch"; $script:LastSkipLog = $new }
    return
  }

  $changed = @(Git-Out diff --name-only $old $new -- . | Where-Object { $_ })
  $message = (Git-Out log -1 --format=%s $new | Select-Object -First 1)
  Git-Out merge --ff-only --quiet $new | Out-Null
  if ($changed.Count -eq 0) {
    Log "Nouveau commit $($new.Substring(0,7)) sans changement pour le bot : pas de redemarrage."
    return
  }
  Log "Mise a jour $($old.Substring(0,7)) -> $($new.Substring(0,7)) : $message"
  $depsChanged = @($changed | Where-Object { $_ -match 'package(-lock)?\.json$' }).Count -gt 0
  $swapped = $false

  $rollback = {
    param([string]$reason)
    Log "ECHEC ($reason) -> retour a $($old.Substring(0,7))"
    Set-Content -Path $BadFile -Value $new
    Git-Out reset --hard --quiet $old | Out-Null
    if ($depsChanged) { Invoke-Npm @('ci', '--no-audit', '--no-fund') | Out-Null }
    Write-Deploy 'rollback' $new $old $message $reason
    # Si la nouvelle version n'a jamais ete mise en place, l'ancienne tourne toujours.
    if ($swapped) {
      Stop-Bot
      if (Test-Path 'dist') { Remove-Item -Recurse -Force 'dist' }
      Rename-Item 'dist-prev' 'dist'
      Start-Bot
    }
  }

  if ($depsChanged) {
    Log 'Dependances modifiees : npm ci'
    Stop-Bot # Windows verrouille les modules natifs utilises par le bot
    $ok = Invoke-Npm @('ci', '--no-audit', '--no-fund')
    if (-not $ok) { & $rollback 'installation des dependances'; if ($script:Bot.HasExited) { Start-Bot }; return }
  }

  if (Test-Path 'dist-next') { Remove-Item -Recurse -Force 'dist-next' }
  $ok = Invoke-Npm @('run', 'build', '--silent', '--', '--outDir', 'dist-next')
  if (-not $ok) {
    if (Test-Path 'dist-next') { Remove-Item -Recurse -Force 'dist-next' }
    & $rollback 'compilation'
    if ($script:Bot.HasExited) { Start-Bot }
    return
  }

  Stop-Bot
  if (Test-Path 'dist-prev') { Remove-Item -Recurse -Force 'dist-prev' }
  if (Test-Path 'dist') { Rename-Item 'dist' 'dist-prev' }
  Rename-Item 'dist-next' 'dist'
  $swapped = $true
  Write-Deploy 'updated' $new $old $message ''
  Start-Bot

  if (Wait-Healthy) {
    if (Test-Path $BadFile) { Remove-Item $BadFile -Force }
    Log "Mise a jour $($new.Substring(0,7)) en ligne."
  } else {
    & $rollback 'le bot ne s''est pas reconnecte a Discord apres la mise a jour'
  }
}

# --------------------------- Boucle principale ---------------------------
if (-not (Test-Path 'node_modules')) {
  Log 'Installation des dependances...'
  if (-not (Invoke-Npm @('ci', '--no-audit', '--no-fund'))) { Log 'npm ci a echoue.'; exit 1 }
}
if (-not (Test-Path 'dist\index.js')) {
  Log 'Compilation...'
  if (-not (Invoke-Npm @('run', 'build', '--silent'))) { Log 'La compilation a echoue.'; exit 1 }
}

if ($UpdatesEnabled) { Log "Mises a jour automatiques actives (branche $Branch, verification chaque minute)." }
Start-Bot
$lastCheck = Get-Date

while ($true) {
  Start-Sleep -Seconds 5
  if ($script:Bot.HasExited) {
    $code = $script:Bot.ExitCode
    if ($code -eq 2) {
      Log 'Le bot ne peut pas demarrer : erreur de configuration (token, .env, intents...). Voir le message du bot.'
      if (-not $Service) { exit 2 }
      Start-Sleep -Seconds 300 # en service : on reessaie toutes les 5 minutes (le .env a peut-etre ete corrige)
    } else {
      Log "Le bot s'est arrete (code $code). Redemarrage dans 10 secondes."
      Start-Sleep -Seconds 10
    }
    Start-Bot
  }
  if (((Get-Date) - $lastCheck).TotalSeconds -ge 60) {
    $lastCheck = Get-Date
    try { Check-Update } catch { Log "Verification des mises a jour impossible : $($_.Exception.Message)" }
  }
}
