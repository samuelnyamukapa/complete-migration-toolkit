@echo off
title cmtk pilot: 05-review-plan
cd /d "%~dp0"
echo Review the draft cases the AI tester wrote for the eShop catalog.
echo Read tester\cmtk\plans\catalog.md first: it explains each case and lists the open questions.
echo.
node "%~dp0tools\cmtk-0.2.0\cmtk.mjs" check --manifest "%~dp0tester\cmtk.yaml"
echo.
node "%~dp0tools\cmtk-0.2.0\cmtk.mjs" review --manifest "%~dp0tester\cmtk.yaml"
echo.
echo Accepted cases stay in tester\cmtk\cases\catalog.yaml, without "draft: true".
echo Rejected drafts move to tester\cmtk\rejected.yaml, with your reason.
pause
