@echo off
title cmtk pilot: 12-review-0.6
cd /d "%~dp0"
echo Your decisions, cmtk 0.6: P-001 (the canary defect, time this one) and P-002 (LEG-1 as a known issue).
echo Then the run again, which should say PASS WITH KNOWN ISSUES. Then the forms: type A and yes on the invalid file, q on the valid.
node tools\cmtk-0.6\cmtk.mjs review --manifest cmtk-06.yaml
node tools\cmtk-0.6\cmtk.mjs run --manifest cmtk-06.yaml
echo Exit code %ERRORLEVEL% (4 expected)
xcopy /y /q tools\cmtk-0.6\cmtk.mjs tools\cmtk\ >nul
call 10-data-forms.cmd
