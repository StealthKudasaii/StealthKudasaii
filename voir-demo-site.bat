@echo off
chcp 65001 >nul
cd /d "%~dp0"
call .venv\Scripts\activate
start "" http://127.0.0.1:8080
python -m bot.demo
pause
