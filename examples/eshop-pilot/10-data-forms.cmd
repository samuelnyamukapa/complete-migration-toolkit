@echo off
title cmtk pilot: 10-data-forms
cd /d "%~dp0"
echo Part 5: the generated catalog-item rows, posted to legacy eShop's Create form.
echo Legacy must be running (06-start-legacy.cmd). The invalid rows come first: RULE-009 says
echo an invalid item is shown again with no write, so they change nothing. First, cmtk review
echo asks you to accept or reject each draft case; the run skips any you have not accepted.
echo   10-data-forms.cmd -Valid        also posts the valid rows, which are saved
echo   10-data-forms.cmd -SkipReview   runs without the review
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0steps\data-forms.ps1" %*
echo.
echo Step 10-data-forms finished. The report is tester\cmtk\evidence-forms\run\REPORT.md.
pause
