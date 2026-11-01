@echo off
chcp 65001 >nul
title Aktualizacja repozytorium GitHub (richup-bot)

cd /d "%~dp0"
set GIT="C:\Program Files\Git\cmd\git.exe"

echo Dodawanie zmian do Git...
%GIT% add .gitignore README.md package.json start-bot.bat bot.js
%GIT% commit -m "Update Richup.io bot" 2>nul

echo Wysylanie na GitHub (https://github.com/K4mil-0/richup.io-coins-iddle-bot)...
%GIT% push -u origin main --force

echo.
echo ==============================================================
echo   GOTOWE! Repozytorium na GitHubie zostalo zaktualizowane!
echo ==============================================================
pause
