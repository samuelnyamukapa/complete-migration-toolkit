@echo off
title cmtk pilot: 02-start
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0steps\02-start.ps1"
echo.
echo Step 02-start finished. This window closes in 15 seconds.
timeout /t 15 >nul
