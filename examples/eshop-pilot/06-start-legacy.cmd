@echo off
title cmtk pilot: 06-start-legacy
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0steps\start-legacy.ps1"
echo.
echo Step 06-start-legacy finished. Legacy eShop keeps running until 09-stop.cmd. This window closes in 15 seconds.
timeout /t 15 >nul
