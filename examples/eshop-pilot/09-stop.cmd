@echo off
title cmtk pilot: 09-stop
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0steps\09-stop.ps1"
echo.
echo Step 09-stop finished. This window closes in 15 seconds.
timeout /t 15 >nul
