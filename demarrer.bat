@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Bot or - laisse cette fenetre ouverte
call .venv\Scripts\activate
:loop
python -m bot.main
echo.
echo Le bot s'est arrete. Redemarrage dans 15 secondes (ferme la fenetre pour l'arreter)...
timeout /t 15
goto loop
