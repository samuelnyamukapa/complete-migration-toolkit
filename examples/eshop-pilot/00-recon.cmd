@echo off
title cmtk pilot: 00-recon
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0steps\00-recon.ps1"
echo.
echo Step 00-recon finished. This window closes in 15 seconds.
timeout /t 15 >nul
