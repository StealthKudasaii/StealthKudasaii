@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Installation du bot or ===

where python >nul 2>nul
if errorlevel 1 (
  echo Python n'est pas installe. Installation via winget...
  winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
  echo.
  echo Python vient d'etre installe : FERME cette fenetre et relance installer.bat.
  pause
  exit /b
)

if not exist .venv (
  python -m venv .venv
)
call .venv\Scripts\activate
python -m pip install --upgrade pip >nul
pip install -r requirements.txt
if errorlevel 1 (
  echo Erreur pendant l'installation des modules.
  pause
  exit /b
)

if not exist .env copy .env.example .env >nul
if not exist config.yaml copy config.example.yaml config.yaml >nul

echo.
echo === Etape suivante ===
echo 1. Le fichier .env va s'ouvrir : remplis tes cles (Claude, Telegram, MT5), enregistre, ferme.
pause
notepad .env

echo 2. Connexion a Telegram (numero + code recu dans l'app), puis liste de tes groupes :
python -m bot.list_chats
echo.
echo 3. Note l'ID du groupe de signaux. config.yaml va s'ouvrir :
echo    mets l'ID dans source_chats et le nom de l'or chez ton broker dans symbol.
pause
notepad config.yaml

echo.
echo Installation terminee. Double-clique sur demarrer.bat pour lancer le bot.
pause
