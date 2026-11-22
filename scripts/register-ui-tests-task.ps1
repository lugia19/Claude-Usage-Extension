# Registers (or, with -Unregister, removes) the Task Scheduler entry for the daily UI checks
# (scripts/ui-tests.mjs --scheduled). Re-running replaces the task.
#
# It triggers hourly from 09:00 and at logon; ui-tests.mjs makes that one completed run a day (a run
# skipped because the profile was open just retries next hour). It runs only while you're logged on,
# so a failure can open its report in VS Code, and under a headless conhost so no window flashes.

param([switch]$Unregister)

$TaskName = 'Claude Usage Tracker UI checks'

if ($Unregister) {
	Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
	Write-Output "Removed '$TaskName'."
	return
}

$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source

$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
	-Argument "--headless `"$node`" scripts\ui-tests.mjs --scheduled" -WorkingDirectory $repo

$hourly = New-ScheduledTaskTrigger -Daily -At '09:00'
$hourly.Repetition = (New-ScheduledTaskTrigger -Once -At '09:00' -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 15)).Repetition
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
	-ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $hourly, $logon -Settings $settings `
	-Principal $principal -Description 'Daily headless check that the Usage Tracker still mounts on claude.ai (scripts/ui-tests.mjs).' -Force | Out-Null
Write-Output "Registered '$TaskName': hourly 09:00-24:00 and at logon, at most one completed run a day."
