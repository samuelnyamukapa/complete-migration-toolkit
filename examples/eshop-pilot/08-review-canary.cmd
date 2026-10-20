@echo off
title cmtk pilot: 08-review-canary
cd /d "%~dp0"
echo Review the AI tester's triage of the canary comparison (cmtk\evidence-canary\compare).
echo Each proposal says whether a difference is noise, intended drift or a defect. You decide.
echo.
node "%~dp0tools\cmtk-0.2.0\cmtk.mjs" review --manifest "%~dp0compare-canary.yaml"
echo.
echo Accepted scrubs and drift are written with your name; accepted defects become defect drafts.
pause
