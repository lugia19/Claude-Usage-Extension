# Set your phone's IP (with DHCP reservation)
$IP = "192.168.2.25"

Write-Host "Scanning for ADB port on $IP..." -ForegroundColor Cyan

# Find the open ADB port - match only lines with the format "NUMBER/tcp"
$portLine = nmap $IP -p 36000-44000 | Select-String '^\d+/tcp'

if ($portLine) {
    $port = ($portLine -Split '/')[0]
    Write-Host "Found port: $port" -ForegroundColor Green
    Write-Host "Connecting to $IP`:$port..." -ForegroundColor Cyan
    
    adb connect "$IP`:$port"
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Connected! Running web-ext..." -ForegroundColor Green
        
        web-ext run -t firefox-android --android-device="$IP`:$port" --adb-remove-old-artifacts
    }
    else {
        Write-Host "Failed to connect to device" -ForegroundColor Red
        exit 1
    }
}
else {
    Write-Host "Could not find ADB port. Is wireless debugging enabled?" -ForegroundColor Red
    exit 1
}