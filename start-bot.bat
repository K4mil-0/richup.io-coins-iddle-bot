@echo off
chcp 65001 >nul
title Richup.io Bot Nocny (Host + 2 Boty)

echo ==============================================================
echo   URUCHAMIANIE BOTA RICHUP.IO (TRYB NOCNY)
echo ==============================================================
echo.

:: Zapobieganie usypianiu komputera w nocy (na zasilaniu sieciowym)
powercfg /change standby-timeout-ac 0 >nul 2>&1

cd /d "%~dp0"

:: Uruchomienie przez wbudowany silnik Node.js
if exist "%APPDATA%\Antigravity\bin\agy-node.cmd" (
    call "%APPDATA%\Antigravity\bin\agy-node.cmd" bot.js
) else (
    node bot.js
)

pause
