@echo off
setlocal
set "PI_ROOT=%USERPROFILE%\.pi"
set "PI_NODE=%PI_ROOT%\node_modules\node\bin\node.exe"
set "PI_CLI=%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent\dist\cli.js"
set "PI_LOG_DIR=%PI_ROOT%\agent\logs"
if not exist "%PI_LOG_DIR%" mkdir "%PI_LOG_DIR%" >nul 2>nul
if not exist "%PI_NODE%" (
  echo Stable Node runtime not found: %PI_NODE% 1>&2
  exit /b 127
)
if not exist "%PI_CLI%" (
  echo Pi CLI not found: %PI_CLI% 1>&2
  exit /b 127
)
set "NODE_OPTIONS=--report-on-fatalerror --report-uncaught-exception --report-directory=%PI_LOG_DIR%"
"%PI_NODE%" "%PI_CLI%" %*
set "PI_EXIT=%ERRORLEVEL%"
if not "%PI_EXIT%"=="0" (
  >>"%PI_LOG_DIR%\pi-exits.log" echo [%DATE% %TIME%] exit=%PI_EXIT% cwd=%CD%
)
exit /b %PI_EXIT%
