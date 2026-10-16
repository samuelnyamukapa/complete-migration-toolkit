@echo off
title cmtk pilot: 01-setup
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0steps\01-setup.ps1"
echo.
echo Step 01-setup finished. This window closes in 15 seconds.
timeout /t 15 >nul
