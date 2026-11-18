@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title RBKS PVP - Bot Discord et panel (laisse cette fenetre ouverte)

echo ==========================================
echo    RBKS PVP - Bot Discord officiel
echo ==========================================
echo.

REM --- 1. Node.js installe ? ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Node.js n'est pas installe.
  echo Installe la version LTS ^(22 ou plus^) depuis https://nodejs.org puis relance ce fichier.
  start "" https://nodejs.org/fr/download
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)"
if errorlevel 1 (
  echo [ERREUR] Node.js est trop ancien. Version actuelle :
  node -v
  echo Installe la version 22.12 ou plus recente depuis https://nodejs.org
  pause
  exit /b 1
)

REM --- 2. Dependances (premier lancement ou mise a jour) ---
set NEED_INSTALL=0
if not exist "node_modules\" set NEED_INSTALL=1
if exist "node_modules\" if not exist "node_modules\.package-lock.json" set NEED_INSTALL=1
if "%NEED_INSTALL%"=="0" (
  node -e "const fs=require('fs');process.exit(fs.statSync('package-lock.json').mtimeMs>fs.statSync('node_modules/.package-lock.json').mtimeMs?1:0)"
  if errorlevel 1 set NEED_INSTALL=1
)
if "%NEED_INSTALL%"=="1" (
  echo Installation des dependances ^(quelques minutes la premiere fois^)...
  call npm ci
  if errorlevel 1 (
    echo.
    echo [ERREUR] L'installation a echoue. Verifie ta connexion Internet.
    echo Si l'erreur parle de better-sqlite3, installe les "Outils de generation Visual Studio".
    pause
    exit /b 1
  )
)

REM --- 3. Fichier .env ---
node scripts\prepare-env.cjs
if errorlevel 3 (
  echo.
  echo Le fichier .env va s'ouvrir dans le Bloc-notes. Remplis les valeurs, enregistre, puis relance ce fichier.
  start "" notepad ".env"
  pause
  exit /b 1
)
if errorlevel 1 (
  pause
  exit /b 1
)

REM --- 4. Compilation ---
echo Compilation...
call npm run build --silent
if errorlevel 1 (
  echo [ERREUR] La compilation a echoue.
  pause
  exit /b 1
)

REM --- 5. Lancement, redemarrage automatique et mises a jour depuis GitHub ---
echo.
echo Demarrage du bot... ^(ferme cette fenetre ou Ctrl+C pour l'arreter^)
echo Si ce dossier vient d'un "git clone", le bot se met a jour tout seul a chaque push sur GitHub.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\windows\rbks-vps.ps1"
set CODE=%errorlevel%
if "%CODE%"=="3" (
  echo.
  echo Le bot tourne deja en arriere-plan ^(demarrage automatique installe^). Rien a faire.
  pause
  exit /b 0
)
if "%CODE%"=="2" (
  echo.
  echo [ERREUR] Le bot ne peut pas demarrer : lis le message ci-dessus ^(token, .env, intents...^).
  echo Corrige le probleme puis relance ce fichier.
)
pause
exit /b %CODE%
