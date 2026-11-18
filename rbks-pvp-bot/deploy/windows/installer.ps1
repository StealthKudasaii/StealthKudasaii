# -----------------------------------------------------------------------------
#  RBKS PVP - installation complete sur Windows (VPS ou PC), en une fois.
#  Lance par INSTALLER-RBKS-PVP.bat (en administrateur).
#
#  1. Installe Git et Node.js si besoin (silencieusement).
#  2. Telecharge le bot dans C:\RBKS-PVP (ou le met a jour s'il y est deja).
#  3. Installe les dependances et ouvre .env dans le Bloc-notes pour le token.
#  4. Compile, installe le demarrage automatique (tache planifiee) et lance le bot.
#  5. Ouvre le lien d'invitation du bot dans le navigateur.
#  Relancer l'installateur est sans risque (reparation / mise a jour).
#  Fichier volontairement en ASCII (compatibilite Windows PowerShell 5.1).
# -----------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # sinon les telechargements sont tres lents
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoUrl = 'https://github.com/StealthKudasaii/StealthKudasaii.git'
$Branch = 'main'
$InstallDir = 'C:\RBKS-PVP'
$AppDir = Join-Path $InstallDir 'rbks-pvp-bot'
$TaskName = 'RBKS PVP Bot'
$Tmp = Join-Path $env:TEMP 'rbks-install'
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

function Step([string]$msg) { Write-Host ''; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "    OK : $msg" -ForegroundColor Green }
function Fail([string]$msg) {
  Write-Host ''
  Write-Host "ERREUR : $msg" -ForegroundColor Red
  Write-Host 'Fais une capture de cette fenetre et envoie-la pour obtenir de l''aide.'
  exit 1
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Has([string]$cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Download([string]$url, [string]$file) {
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file -Headers @{ 'User-Agent' = 'rbks-installer' }
}

Write-Host '=============================================' -ForegroundColor DarkYellow
Write-Host '     RBKS PVP - Installation du bot Discord' -ForegroundColor DarkYellow
Write-Host '=============================================' -ForegroundColor DarkYellow

# ------------------------------------------------------------------ Git
Step 'Git'
Refresh-Path
if (Has 'git') {
  Ok (& git --version)
} else {
  Write-Host '    Installation de Git (1 a 2 minutes)...'
  try {
    $rel = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'rbks-installer' }
    $asset = $rel.assets | Where-Object { $_.name -match '^Git-[\d.]+-64-bit\.exe$' } | Select-Object -First 1
    if (-not $asset) { throw 'installateur introuvable' }
    $exe = Join-Path $Tmp $asset.name
    Download $asset.browser_download_url $exe
    $p = Start-Process -FilePath $exe -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "code $($p.ExitCode)" }
  } catch {
    Fail "installation de Git impossible ($($_.Exception.Message)). Installe-le a la main depuis https://git-scm.com/download/win puis relance."
  }
  Refresh-Path
  if (-not (Has 'git')) { Fail 'Git est installe mais introuvable. Redemarre le VPS puis relance l''installateur.' }
  Ok (& git --version)
}

# ------------------------------------------------------------------ Node.js
Step 'Node.js'
$needNode = $true
if (Has 'node') {
  $v = (& node -v).TrimStart('v').Split('.')
  if ([int]$v[0] -gt 22 -or ([int]$v[0] -eq 22 -and [int]$v[1] -ge 12)) { $needNode = $false }
}
if ($needNode) {
  Write-Host '    Installation de Node.js 24 LTS (1 a 2 minutes)...'
  try {
    $index = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json'
    $ver = ($index | Where-Object { $_.version -like 'v24.*' -and $_.lts } | Select-Object -First 1).version
    if (-not $ver) { throw 'version introuvable' }
    $msi = Join-Path $Tmp "node-$ver-x64.msi"
    Download "https://nodejs.org/dist/$ver/node-$ver-x64.msi" $msi
    $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait -PassThru
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "code $($p.ExitCode)" }
  } catch {
    Fail "installation de Node.js impossible ($($_.Exception.Message)). Installe la version LTS depuis https://nodejs.org puis relance."
  }
  Refresh-Path
  if (-not (Has 'node')) { Fail 'Node.js est installe mais introuvable. Redemarre le VPS puis relance l''installateur.' }
}
Ok "Node.js $(& node -v)"

# ------------------------------------------------------------------ Arret d'une version deja installee
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$botProcs = @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*dist\index.js*') -or ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*rbks-vps.ps1*') })
if ($task -or $botProcs.Count -gt 0) {
  Step 'Arret du bot deja installe (mise a jour)'
  if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  foreach ($proc in $botProcs) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Ok 'bot arrete'
}

# ------------------------------------------------------------------ Code du bot
Step "Telechargement du bot dans $InstallDir"
if (Test-Path (Join-Path $InstallDir '.git')) {
  & git -c safe.directory=* -C $InstallDir pull --ff-only origin $Branch
  if ($LASTEXITCODE -ne 0) { Write-Host '    (mise a jour impossible, on garde la version presente)' -ForegroundColor Yellow }
} else {
  if ((Test-Path $InstallDir) -and (Get-ChildItem $InstallDir -Force | Select-Object -First 1)) {
    Fail "$InstallDir existe deja et n'est pas une installation du bot. Renomme ou supprime ce dossier, puis relance."
  }
  & git clone --branch $Branch $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) { Fail 'telechargement du depot impossible (connexion Internet ?).' }
}
if (-not (Test-Path (Join-Path $AppDir 'package.json'))) { Fail "dossier rbks-pvp-bot introuvable dans $InstallDir." }
Set-Location $AppDir
Ok 'code du bot a jour'

# ------------------------------------------------------------------ Dependances
Step 'Installation des dependances (quelques minutes la premiere fois)'
& npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail 'npm ci a echoue (connexion Internet ?).' }
Ok 'dependances installees'

# ------------------------------------------------------------------ Configuration
Step 'Configuration (.env)'
while ($true) {
  & node scripts\prepare-env.cjs
  if ($LASTEXITCODE -eq 0) { break }
  Write-Host ''
  Write-Host '    Le Bloc-notes va s''ouvrir. Colle tes valeurs apres les "=", ENREGISTRE (Ctrl+S)' -ForegroundColor Yellow
  Write-Host '    puis FERME le Bloc-notes pour continuer l''installation.' -ForegroundColor Yellow
  Write-Host '    Ou trouver les valeurs : https://discord.com/developers/applications'
  Write-Host '      DISCORD_TOKEN         -> ton application > Bot > Reset Token'
  Write-Host '      DISCORD_CLIENT_ID     -> ton application > General Information > Application ID'
  Write-Host '      DISCORD_CLIENT_SECRET -> ton application > OAuth2 > Reset Secret'
  Write-Host '      GUILD_ID              -> Discord : clic droit sur ton serveur > Copier l''identifiant'
  Write-Host '                               (active d''abord Parametres > Avances > Mode developpeur)'
  Write-Host '    Pense aussi a activer "Server Members Intent" et "Message Content Intent" (onglet Bot).'
  Start-Process -FilePath 'notepad.exe' -ArgumentList (Join-Path $AppDir '.env') -Wait
}
Ok 'configuration complete'

# ------------------------------------------------------------------ Compilation
Step 'Compilation'
& npm run build --silent
if ($LASTEXITCODE -ne 0) { Fail 'la compilation a echoue.' }
Ok 'bot compile'

# ------------------------------------------------------------------ Demarrage automatique + lancement
Step 'Demarrage automatique avec Windows et lancement du bot'
$script = Join-Path $AppDir 'deploy\windows\rbks-vps.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Service" -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
# ExecutionTimeLimit = 0 : sans cela, Windows arrete la tache au bout de 3 jours.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Ok 'tache planifiee "RBKS PVP Bot" installee et lancee'

# ------------------------------------------------------------------ Verification
Step 'Connexion du bot a Discord (jusqu''a 1 minute)'
$port = '3000'
$line = Get-Content (Join-Path $AppDir '.env') | Where-Object { $_ -match '^\s*WEB_PORT\s*=' } | Select-Object -Last 1
if ($line) { $port = ($line -split '=', 2)[1].Trim() }
$connected = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try {
    $h = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
    if ($h.discord -eq $true) { $connected = $true; break }
  } catch { }
}
if ($connected) {
  Ok 'le bot est connecte a Discord'
} else {
  Write-Host '    Le bot ne s''est pas connecte. Derniers messages :' -ForegroundColor Yellow
  foreach ($f in @('data\bot-error.log', 'data\bot.log')) {
    $path = Join-Path $AppDir $f
    if (Test-Path $path) { Get-Content $path -Tail 6 | ForEach-Object { Write-Host "      $_" } }
  }
  Write-Host '    Le plus souvent : token incorrect, ou intents "Server Members" / "Message Content" non actives.' -ForegroundColor Yellow
  Write-Host '    Corrige .env (Bloc-notes) puis relance INSTALLER-RBKS-PVP.bat.' -ForegroundColor Yellow
}

# ------------------------------------------------------------------ Invitation
$invite = (& node dist\scripts\invite.js) | Where-Object { $_ -like 'https://*' } | Select-Object -First 1
Write-Host ''
Write-Host '=============================================' -ForegroundColor Green
Write-Host '   Installation terminee !' -ForegroundColor Green
Write-Host '=============================================' -ForegroundColor Green
Write-Host ''
Write-Host 'Il te reste 3 choses a faire sur Discord :'
Write-Host '  1. Inviter le bot : le lien s''ouvre dans ton navigateur (copie-le ci-dessous sinon).'
Write-Host "     $invite"
Write-Host '  2. Parametres du serveur > Roles : glisse le role du bot tout en haut de la liste.'
Write-Host '  3. Tape /setup installer puis clique sur Appliquer.'
Write-Host ''
Write-Host 'Le bot tourne en arriere-plan (meme fenetre fermee), redemarre avec le VPS'
Write-Host 'et se met a jour tout seul a chaque push sur GitHub.'
Write-Host "Dossier : $AppDir   |   Journaux : $AppDir\data\bot.log et vps.log"
Write-Host "Panel web (sur ce VPS) : http://localhost:$port"
if ($invite) { Start-Process $invite }
