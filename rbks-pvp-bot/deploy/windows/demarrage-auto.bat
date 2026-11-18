@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM Droits administrateur obligatoires pour creer la tache planifiee.
net session >nul 2>nul
if errorlevel 1 (
  echo Ce fichier doit etre lance en administrateur :
  echo clic droit sur demarrage-auto.bat ^> "Executer en tant qu'administrateur".
  pause
  exit /b 1
)
echo  1 = Installer le demarrage automatique (le bot tourne en arriere-plan, meme apres un redemarrage du VPS)
echo  2 = Supprimer le demarrage automatique et arreter le bot
echo.
set /p CHOIX=Ton choix (1 ou 2) : 
if "%CHOIX%"=="2" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0demarrage-auto.ps1" -Remove
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0demarrage-auto.ps1"
)
pause
