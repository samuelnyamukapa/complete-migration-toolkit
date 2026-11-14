@echo off
title cmtk pilot: 11b-verify-browser
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0steps\verify-06b.ps1" %*
echo Finished. The results are in logs\11b-verify-summary.txt.
pause
