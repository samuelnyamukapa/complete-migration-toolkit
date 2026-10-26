@echo off
title cmtk pilot: 06b-start-legacy-console
cd /d "%~dp0"
rem Starts legacy eShop with IIS Express in this window, which stays open while legacy runs and
rem shows every request. Close the window (or run 09-stop.cmd) to stop it. No PowerShell.
set IIS_USER_HOME=%~dp0scratch\iisexpress-home
if not exist "%IIS_USER_HOME%" mkdir "%IIS_USER_HOME%"
echo Starting legacy eShop on http://localhost:53190/ ...
"C:\Program Files\IIS Express\iisexpress.exe" /path:"%~dp0scratch\legacy\src\eShopLegacyMVC" /port:53190 /systray:false /clr:v4.0
echo.
echo IIS Express stopped, exit code %ERRORLEVEL%.
pause
