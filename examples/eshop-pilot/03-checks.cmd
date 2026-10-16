@echo off
title cmtk pilot: 03-checks
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0steps\03-checks.ps1"
echo.
echo Step 03-checks finished. This window closes in 15 seconds.
timeout /t 15 >nul
