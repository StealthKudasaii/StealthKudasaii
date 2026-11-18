@echo off
REM ===================================================================
REM  RBKS PVP - installateur Windows en un clic.
REM  Installe Git, Node.js et le bot, demande le token, lance le bot en
REM  arriere-plan (demarrage avec Windows + mises a jour automatiques)
REM  et ouvre le lien d'invitation. Peut etre relance pour reparer.
REM ===================================================================
chcp 65001 >nul
title RBKS PVP - Installation

REM Droits administrateur (necessaires pour installer Git/Node et la tache de demarrage).
net session >nul 2>nul
if errorlevel 1 (
  echo Demande des droits administrateur...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Telechargement de l'installateur...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/StealthKudasaii/StealthKudasaii/main/rbks-pvp-bot/deploy/windows/installer.ps1' -OutFile '%TEMP%\rbks-installer.ps1'"
if errorlevel 1 (
  echo.
  echo [ERREUR] Impossible de telecharger l'installateur. Verifie la connexion Internet du VPS.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\rbks-installer.ps1"
echo.
pause
