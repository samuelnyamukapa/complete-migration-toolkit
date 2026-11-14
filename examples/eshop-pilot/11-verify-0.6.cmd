@echo off
title cmtk pilot: 11-verify-0.6
cd /d "%~dp0"
echo cmtk 0.6 on eShop. Legacy must be running (06b-start-legacy-console.cmd). No signature is touched, and no decision is made.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0steps\verify-06.ps1" %*
echo.
echo Finished. The results are in logs\11-verify-summary.txt.
pause
