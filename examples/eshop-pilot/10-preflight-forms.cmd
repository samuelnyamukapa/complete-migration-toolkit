@echo off
title cmtk pilot: 10-preflight-forms
cd /d "%~dp0"
echo Preflight for part 5: regenerates the rows, checks the settings, and reads legacy's Create page
echo for the token field and the cookie. Sends no POST and starts no review.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0steps\data-forms.ps1" -Preflight
echo.
echo Preflight finished. The log is logs\10-data-forms.log. This window closes in 20 seconds.
timeout /t 20 >nul
