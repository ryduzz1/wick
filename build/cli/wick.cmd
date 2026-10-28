@echo off
rem The `wick` command for the packaged app. Add this folder to PATH to use it anywhere.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Wick.exe" "%~dp0..\app.asar\bin\wick.js" %*
