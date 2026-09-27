# One-shot fixer: rebuild DograhTunnelWatchdog so it truly runs every 5 min
# around the clock, logs properly, and runs even on battery / after wake.
# The action runs the .cmd wrapper (owns quoting, PATH incl. docker, logging).
$ErrorActionPreference = 'Stop'
$root = 'D:\my LLM\.n8n-files\website\secondshift'

schtasks /Delete /TN DograhTunnelWatchdog /F | Out-Null

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument (
  '/c "' + $root + '\scripts\dograh-watchdog.cmd"')

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName 'DograhTunnelWatchdog' -Action $action `
  -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Output 'TASK-REBUILT'
