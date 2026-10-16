@echo off
title cmtk pilot: 04-final
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0steps\04-final.ps1"
echo.
echo Step 04-final finished. This window closes in 15 seconds.
timeout /t 15 >nul
