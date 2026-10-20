@echo off
title cmtk pilot: 07-ping-legacy
cd /d "%~dp0"
echo Checking legacy eShop on port 53190 ...
> logs\07-ping-legacy.log (
  echo == 07-ping-legacy %DATE% %TIME%
  tasklist /fi "imagename eq iisexpress.exe"
  curl.exe -s -o NUL -m 15 -w "curl -4 GET / -> %%{http_code} in %%{time_total}s" -4 http://localhost:53190/
  echo.
  curl.exe -s -o NUL -m 15 -w "curl -6 GET / -> %%{http_code} in %%{time_total}s" -6 http://localhost:53190/
  echo.
  curl.exe -s -o NUL -m 15 -w "curl 127.0.0.1 GET / -> %%{http_code} in %%{time_total}s" http://127.0.0.1:53190/
  echo.
  powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri http://localhost:53190/ -UseBasicParsing -TimeoutSec 15; 'powershell GET / -> ' + $r.StatusCode } catch { 'powershell GET / -> ' + $_.Exception.Message }"
  powershell -NoProfile -Command "[System.Net.WebRequest]::DefaultWebProxy.GetProxy('http://localhost:53190/').AbsoluteUri"
  echo == end
)
type logs\07-ping-legacy.log
timeout /t 10 >nul
