@echo off
cd /d "D:\my LLM\.n8n-files\website\secondshift"
set PATH=%PATH%;C:\Users\Acer\AppData\Local\Programs\DockerDesktop\resources\bin
:loop
"D:\node.exe" "scripts\dograh-watchdog.js" >> "D:\my LLM\.n8n-files\website\secondshift\watchdog.log" 2>&1
timeout /t 300 /nobreak >/dev/null
goto loop
