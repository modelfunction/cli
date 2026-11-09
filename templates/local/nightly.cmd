@echo off
rem Change-gated nightly eval for Windows Task Scheduler.
rem Point the scheduled task at this file after setting MODEL_API_KEY in the
rem task environment (or in a wrapper script that is not committed).
setlocal

if "%MF_VERSION%"=="" set MF_VERSION=0.7.0
if "%MF_SUITE%"=="" set MF_SUITE=mf.suite.json
if "%MF_MODELS%"=="" set MF_MODELS=mf.models.json
if "%MF_NIGHTLY_DIR%"=="" set MF_NIGHTLY_DIR=.mf\nightly
if "%MF_BASELINE%"=="" set MF_BASELINE=.mf\baseline.json
if "%MF_MAX_COST%"=="" set MF_MAX_COST=1
if "%MF_REPEAT%"=="" set MF_REPEAT=3
if "%MF_RETRY%"=="" set MF_RETRY=4
if "%MF_MIN_INTERVAL%"=="" set MF_MIN_INTERVAL=1200

if not exist "%MF_NIGHTLY_DIR%" mkdir "%MF_NIGHTLY_DIR%"

node "%~dp0change-detect.mjs" --exit-code
set MF_DECISION=%ERRORLEVEL%
if "%MF_DECISION%"=="0" (
  echo [mf] inventory unchanged; skipping eval ^(0 model calls^)
  exit /b 0
)
if not "%MF_DECISION%"=="1" (
  echo [mf] change detection failed ^(exit %MF_DECISION%^)
  exit /b 2
)

for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set MF_STAMP=%%i
set MF_OUT=%MF_NIGHTLY_DIR%\scorecard.%MF_STAMP%.json
set MF_ARGS=eval --suite "%MF_SUITE%" --models-file "%MF_MODELS%" --repeat %MF_REPEAT% --max-cost %MF_MAX_COST% --retry %MF_RETRY% --min-interval %MF_MIN_INTERVAL% --out "%MF_OUT%"
if not "%MF_PROFILE%"=="" set MF_ARGS=%MF_ARGS% --profile "%MF_PROFILE%"
if exist "%MF_BASELINE%" (
  set MF_ARGS=%MF_ARGS% --baseline "%MF_BASELINE%" --fail-on-regression
) else (
  echo [mf] no baseline at %MF_BASELINE% yet; running without the regression gate
)

call npx -y modelfunction-cli@%MF_VERSION% %MF_ARGS%
set MF_CODE=%ERRORLEVEL%
if "%MF_CODE%"=="0" if exist "%MF_OUT%" node "%~dp0change-detect.mjs" --mark >nul
exit /b %MF_CODE%
