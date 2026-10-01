@echo off
setlocal DisableDelayedExpansion
set "BASE=http://127.0.0.1:8770"
set "COMMAND=%~1"

if not defined COMMAND goto help
if /I "%COMMAND%"=="help" goto help
if /I "%COMMAND%"=="health" goto health
if /I "%COMMAND%"=="tv_cocina" goto tv_cocina
if /I "%COMMAND%"=="tv_dormitorio" goto tv_dormitorio
if /I "%COMMAND%"=="aire_cocina" goto aire_cocina
if /I "%COMMAND%"=="youtube_play" goto youtube_play

echo {"error":"unsupported_fast_command","command":"%COMMAND%","nextStep":"Use C:\sol\sol-fast.ps1 for discovery or complex/raw commands."}
exit /b 2

:health
curl.exe -sS --max-time 5 "%BASE%/health"
exit /b %ERRORLEVEL%

:help
curl.exe -sS --max-time 5 "%BASE%/help"
exit /b %ERRORLEVEL%

:tv_cocina
set "PAYLOAD=%TEMP%\sol-fast-%RANDOM%-%RANDOM%.json"
> "%PAYLOAD%" echo({"command":"tv_cocina","arguments":{}}
curl.exe -sS --max-time 10 -X POST "%BASE%/quick" -H "Content-Type: application/json" --data-binary "@%PAYLOAD%"
set "RC=%ERRORLEVEL%"
del "%PAYLOAD%" >nul 2>nul
exit /b %RC%

:tv_dormitorio
set "PAYLOAD=%TEMP%\sol-fast-%RANDOM%-%RANDOM%.json"
> "%PAYLOAD%" echo({"command":"tv_dormitorio","arguments":{}}
curl.exe -sS --max-time 10 -X POST "%BASE%/quick" -H "Content-Type: application/json" --data-binary "@%PAYLOAD%"
set "RC=%ERRORLEVEL%"
del "%PAYLOAD%" >nul 2>nul
exit /b %RC%

:aire_cocina
set "PAYLOAD=%TEMP%\sol-fast-%RANDOM%-%RANDOM%.json"
> "%PAYLOAD%" echo({"command":"aire_cocina","arguments":{}}
curl.exe -sS --max-time 10 -X POST "%BASE%/quick" -H "Content-Type: application/json" --data-binary "@%PAYLOAD%"
set "RC=%ERRORLEVEL%"
del "%PAYLOAD%" >nul 2>nul
exit /b %RC%

:youtube_play
set "URL=%~2"
set "TARGET=%~3"
if not defined TARGET set "TARGET=cocina"
if not defined URL (
  echo {"error":"youtube_url_required"}
  exit /b 2
)
if /I not "%URL:~0,4%"=="http" set "URL=https://www.youtube.com/watch?v=%URL%"
set "PAYLOAD=%TEMP%\sol-fast-%RANDOM%-%RANDOM%.json"
> "%PAYLOAD%" echo({"command":"youtube_play","confirmedByUser":true,"arguments":{"url":"%URL%","target":"%TARGET%"}}
curl.exe -sS --max-time 20 -X POST "%BASE%/quick" -H "Content-Type: application/json" --data-binary "@%PAYLOAD%"
set "RC=%ERRORLEVEL%"
del "%PAYLOAD%" >nul 2>nul
exit /b %RC%
