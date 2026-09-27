@echo off
rem Wrapper for the DograhTunnelWatchdog scheduled task.
rem Owns quoting/PATH/logging so the task action stays trivial:
rem   cmd.exe /c "D:\my LLM\.n8n-files\website\secondshift\scripts\dograh-watchdog.cmd"
set PATH=%PATH%;C:\Users\Acer\AppData\Local\Programs\DockerDesktop\resources\bin
cd /d "D:\my LLM\.n8n-files\website\secondshift"
"D:\node.exe" "scripts\dograh-watchdog.js" >> "D:\my LLM\.n8n-files\website\secondshift\watchdog.log" 2>&1
exit /b %ERRORLEVEL%
