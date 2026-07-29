param(
    [switch]$Check,
    [switch]$Ensure,
    [switch]$InstallMissing,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Write-Output "[Android] Automatic Windows Android setup must run on Windows"
    Write-Output "__SHORTDRAMA_STATE__ state=unsupported_host"
    exit 19
}

function Show-Usage {
    Write-Output @"
Usage: powershell.exe -File start_avd.ps1 [-Check|-Ensure] [-InstallMissing]

  -Check           Inspect only. Do not install packages or start an AVD.
  -Ensure          Start a configured device/AVD and wait until it is ready.
  -InstallMissing  Install Android/Java packages and create the AVD if needed.

Environment overrides:
  ANDROID_SERIAL, ANDROID_HOME, ANDROID_SDK_ROOT
  SHORTDRAMA_AVD_NAME, SHORTDRAMA_ANDROID_API, SHORTDRAMA_ANDROID_ARCH
  SHORTDRAMA_BOOT_TIMEOUT, SHORTDRAMA_SDK_ROOT
"@
}

if ($Help) {
    Show-Usage
    exit 0
}
if ($Check -and $Ensure) {
    Write-Error "Use either -Check or -Ensure, not both"
    exit 2
}

$Mode = if ($Check) { "check" } else { "ensure" }
$AvdName = if ($env:SHORTDRAMA_AVD_NAME) { $env:SHORTDRAMA_AVD_NAME } else { "hongguo" }
$AndroidApi = if ($env:SHORTDRAMA_ANDROID_API) { $env:SHORTDRAMA_ANDROID_API } else { "34" }
$BootTimeout = if ($env:SHORTDRAMA_BOOT_TIMEOUT) { [int]$env:SHORTDRAMA_BOOT_TIMEOUT } else { 420 }
$DefaultSdkRoot = Join-Path $env:LOCALAPPDATA "Android\Sdk"
$SdkRoot = if ($env:SHORTDRAMA_SDK_ROOT) {
    $env:SHORTDRAMA_SDK_ROOT
} elseif ($env:ANDROID_SDK_ROOT) {
    $env:ANDROID_SDK_ROOT
} elseif ($env:ANDROID_HOME) {
    $env:ANDROID_HOME
} else {
    $DefaultSdkRoot
}
$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot

function Write-Log([string]$Message) {
    Write-Output "[Android] $Message"
}

function Write-State([string]$Name, [string[]]$Extra = @()) {
    $line = "__SHORTDRAMA_STATE__ state=$Name"
    foreach ($item in $Extra) {
        if ($item) { $line += " $item" }
    }
    Write-Output $line
}

function Stop-WithState([int]$Code, [string]$Name, [string]$Message) {
    Write-Log $Message
    Write-State $Name
    exit $Code
}

function Get-AndroidArch {
    $architecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITEW6432")
    if (-not $architecture) {
        $architecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE")
    }
    if ($architecture -notmatch '^(AMD64|x86_64)$') {
        Stop-WithState 18 "unsupported_arch" "Automated AVD installation supports Windows x64 only; current architecture: $architecture"
    }
    if ($env:SHORTDRAMA_ANDROID_ARCH -and $env:SHORTDRAMA_ANDROID_ARCH -ne "x86_64") {
        Stop-WithState 18 "unsupported_arch" "Windows x64 requires the x86_64 Android system image"
    }
    return "x86_64"
}

function Find-Tool([string]$Name) {
    $leaf = if ($Name -in @("adb", "emulator")) { "$Name.exe" } else { "$Name.bat" }
    $candidates = @(
        (Join-Path $SdkRoot "platform-tools\$leaf"),
        (Join-Path $SdkRoot "emulator\$leaf"),
        (Join-Path $SdkRoot "cmdline-tools\latest\bin\$leaf"),
        (Join-Path $SdkRoot "tools\bin\$leaf")
    )

    $cmdlineRoot = Join-Path $SdkRoot "cmdline-tools"
    if (Test-Path $cmdlineRoot) {
        $versionDirs = Get-ChildItem -Path $cmdlineRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object -Property Name -Descending
        foreach ($dir in $versionDirs) {
            $candidates += Join-Path $dir.FullName "bin\$leaf"
        }
    }

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate -PathType Leaf) { return $candidate }
    }
    $command = Get-Command $leaf -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

function Refresh-Tools {
    $script:Adb = Find-Tool "adb"
    $script:Emulator = Find-Tool "emulator"
    $script:SdkManager = Find-Tool "sdkmanager"
    $script:AvdManager = Find-Tool "avdmanager"
}

function Get-DeviceLines {
    if (-not $script:Adb) { return @() }
    $lines = @(& $script:Adb devices 2>$null)
    $devices = @()
    foreach ($line in $lines) {
        if ($line -match '^([^\s]+)\s+device\s*$' -and $Matches[1] -ne "List") {
            $devices += $Matches[1]
        }
    }
    return $devices
}

function Get-ReadyDevice {
    if ($env:ANDROID_SERIAL) {
        if (-not $script:Adb) { return $null }
        $state = ((& $script:Adb -s $env:ANDROID_SERIAL get-state 2>$null) | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $state -eq "device") { return $env:ANDROID_SERIAL }
        return $null
    }

    $devices = @(Get-DeviceLines)
    $emulatorDevice = $devices | Where-Object { $_ -like "emulator-*" } | Select-Object -First 1
    if ($emulatorDevice) { return $emulatorDevice }
    if ($devices.Count -eq 1) { return $devices[0] }
    return $null
}

function Test-AvdExists {
    if (-not $script:Emulator) { return $false }
    $avds = @(& $script:Emulator -list-avds 2>$null)
    return [bool]($avds | Where-Object { $_.Trim() -eq $AvdName } | Select-Object -First 1)
}

function Find-Java {
    $candidates = @()
    $command = Get-Command "java.exe" -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    $roots = @(
        (Join-Path $env:ProgramFiles "Microsoft"),
        (Join-Path $env:ProgramFiles "Eclipse Adoptium"),
        (Join-Path $env:ProgramFiles "Java"),
        (Join-Path $env:ProgramFiles "Android\Android Studio\jbr")
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $matches = Get-ChildItem -Path $root -Filter "java.exe" -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\bin\\java\.exe$' } |
            Sort-Object -Property FullName -Descending
        if ($matches) { $candidates += @($matches | ForEach-Object { $_.FullName }) }
    }
    foreach ($candidate in @($candidates | Select-Object -Unique)) {
        $versionLine = ((& $candidate -version 2>&1) | Select-Object -First 1 | Out-String).Trim()
        if ($versionLine -match 'version "1\.(\d+)' -and [int]$Matches[1] -ge 17) {
            return $candidate
        }
        if ($versionLine -match 'version "(\d+)' -and [int]$Matches[1] -ge 17) {
            return $candidate
        }
    }
    return $null
}

function Use-Java([string]$JavaPath) {
    $javaBin = Split-Path -Parent $JavaPath
    $env:JAVA_HOME = Split-Path -Parent $javaBin
    if (($env:PATH -split ';') -notcontains $javaBin) {
        $env:PATH = "$javaBin;$env:PATH"
    }
}

function Ensure-Java {
    $java = Find-Java
    if ($java) {
        Use-Java $java
        return
    }
    if (-not $InstallMissing) {
        Stop-WithState 12 "missing_android_tools" "Java 17 is required by Android command-line tools"
    }

    $winget = Get-Command "winget.exe" -ErrorAction SilentlyContinue
    if (-not $winget) {
        Stop-WithState 12 "missing_android_tools" "Java is missing and winget is unavailable; install Microsoft App Installer"
    }
    Write-Log "Installing Eclipse Temurin JDK 17 with winget ..."
    & $winget.Source install --id EclipseAdoptium.Temurin.17.JDK -e --source winget `
        --accept-package-agreements --accept-source-agreements --silent --disable-interactivity
    if ($LASTEXITCODE -ne 0) {
        Stop-WithState 12 "missing_android_tools" "winget could not install Eclipse Temurin JDK 17"
    }
    $java = Find-Java
    if (-not $java) {
        Stop-WithState 12 "missing_android_tools" "OpenJDK installation completed but java.exe was not found"
    }
    Use-Java $java
}

function Install-CommandLineTools {
    New-Item -ItemType Directory -Path $SdkRoot -Force | Out-Null
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("shortdrama-android-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Write-Log "Resolving the official Windows Android command-line tools package ..."
        $repositoryUrl = "https://dl.google.com/android/repository/repository2-1.xml"
        [xml]$repository = (Invoke-WebRequest -Uri $repositoryUrl -UseBasicParsing).Content
        $package = $repository.SelectSingleNode("//*[local-name()='remotePackage' and @path='cmdline-tools;latest']")
        if (-not $package) { throw "cmdline-tools;latest was not found in repository metadata" }

        $selected = $null
        foreach ($archive in $package.SelectNodes(".//*[local-name()='archive']")) {
            $hostNode = $archive.SelectSingleNode("./*[local-name()='host-os']")
            if ($hostNode -and $hostNode.InnerText -eq "windows") {
                $selected = $archive
                break
            }
        }
        if (-not $selected) { throw "Windows cmdline-tools archive was not advertised" }

        $complete = $selected.SelectSingleNode("./*[local-name()='complete']")
        $urlNode = $complete.SelectSingleNode("./*[local-name()='url']")
        $checksumNode = $complete.SelectSingleNode("./*[local-name()='checksum']")
        if (-not $urlNode -or -not $checksumNode) { throw "Android repository metadata is incomplete" }

        $archiveName = $urlNode.InnerText.Trim()
        if ($archiveName -notmatch '^commandlinetools-win-[A-Za-z0-9._-]+\.zip$') {
            throw "Unexpected Android archive name: $archiveName"
        }
        $downloadUrl = "https://dl.google.com/android/repository/$archiveName"
        $downloadUri = [Uri]$downloadUrl
        if ($downloadUri.Scheme -ne "https" -or $downloadUri.Host -ne "dl.google.com") {
            throw "Android repository metadata returned an untrusted download URL"
        }
        $zipPath = Join-Path $tempRoot "commandlinetools-win.zip"
        Write-Log "Downloading Android command-line tools from Google ..."
        Invoke-WebRequest -Uri $downloadUri.AbsoluteUri -OutFile $zipPath -UseBasicParsing

        $algorithm = $checksumNode.GetAttribute("type").Replace("-", "").ToUpperInvariant()
        if (-not $algorithm) { $algorithm = "SHA1" }
        if ($algorithm -notin @("SHA1", "SHA256")) { throw "Unsupported checksum type: $algorithm" }
        $expectedHash = $checksumNode.InnerText.Trim().ToLowerInvariant()
        $expectedLength = if ($algorithm -eq "SHA1") { 40 } else { 64 }
        if ($expectedHash -notmatch "^[0-9a-f]{$expectedLength}$") {
            throw "Invalid $algorithm checksum in Android repository metadata"
        }
        $actualHash = (Get-FileHash -Path $zipPath -Algorithm $algorithm).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) { throw "Android command-line tools checksum mismatch" }
        Write-Log "Official checksum verified ($algorithm)"

        $extractRoot = Join-Path $tempRoot "extracted"
        Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force
        $sourceRoot = Join-Path $extractRoot "cmdline-tools"
        if (-not (Test-Path (Join-Path $sourceRoot "bin\sdkmanager.bat"))) {
            throw "Downloaded archive does not contain sdkmanager.bat"
        }
        $latestRoot = Join-Path $SdkRoot "cmdline-tools\latest"
        New-Item -ItemType Directory -Path $latestRoot -Force | Out-Null
        Get-ChildItem -Path $sourceRoot -Force | ForEach-Object {
            Copy-Item -Path $_.FullName -Destination $latestRoot -Recurse -Force
        }
    } catch {
        Stop-WithState 12 "missing_android_tools" "Could not install official Android command-line tools: $($_.Exception.Message)"
    } finally {
        if (Test-Path $tempRoot) {
            Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Refresh-Tools
$ReadySerial = Get-ReadyDevice

if ($Mode -eq "check") {
    if ($ReadySerial) {
        Write-Log "Android device is ready: $ReadySerial"
        Write-State "ready" @("serial=$ReadySerial")
        exit 0
    }
    if (-not $script:Adb -or -not $script:Emulator) {
        Stop-WithState 12 "missing_android_tools" "Android platform-tools or emulator is not installed"
    }
    if (Test-AvdExists) {
        Write-Log "AVD $AvdName is installed but not running"
        Write-State "stopped" @("avd=$AvdName")
        exit 10
    }
    if ($script:SdkManager -and $script:AvdManager) {
        Write-Log "AVD $AvdName is not installed"
        Write-State "missing_avd" @("avd=$AvdName")
        exit 11
    }
    Stop-WithState 12 "missing_android_tools" "Android command-line tools are not installed"
}

if (-not $ReadySerial) {
    $HasAvd = Test-AvdExists
    $NeedsSdkChanges = -not $script:Adb -or -not $script:Emulator -or -not $HasAvd
    $SystemImage = $null
    $imageRoot = $null

    if ($NeedsSdkChanges) {
        if (-not $script:SdkManager -or -not $script:AvdManager) {
            if (-not $InstallMissing) {
                Stop-WithState 12 "missing_android_tools" "Android command-line tools are required to prepare AVD $AvdName"
            }
            Install-CommandLineTools
            Refresh-Tools
            if (-not $script:SdkManager -or -not $script:AvdManager) {
                Stop-WithState 12 "missing_android_tools" "Android tools installation completed without sdkmanager/avdmanager"
            }
        }
        Ensure-Java
        if (-not $HasAvd) {
            $AndroidArch = Get-AndroidArch
            $SystemImage = "system-images;android-$AndroidApi;google_apis;$AndroidArch"
            $imageRoot = Join-Path $SdkRoot "system-images\android-$AndroidApi\google_apis\$AndroidArch"
        }
    }

    if ($NeedsSdkChanges -and
        (-not $script:Adb -or -not $script:Emulator -or (-not $HasAvd -and -not (Test-Path $imageRoot)))) {
        if (-not $InstallMissing) {
            Stop-WithState 12 "missing_android_tools" "Android emulator packages are incomplete"
        }
        Write-Log "Accepting Android SDK licenses for the requested packages ..."
        1..200 | ForEach-Object { "y" } | & $script:SdkManager "--sdk_root=$SdkRoot" --licenses | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Stop-WithState 12 "missing_android_tools" "Android SDK licenses could not be accepted"
        }

        $packages = @("platform-tools", "emulator")
        if (-not $HasAvd) {
            Write-Log "Installing platform-tools, emulator and $SystemImage (this is a multi-GB download) ..."
            $packages += $SystemImage
        } else {
            Write-Log "Installing missing Android platform-tools/emulator packages ..."
        }
        & $script:SdkManager "--sdk_root=$SdkRoot" $packages
        if ($LASTEXITCODE -ne 0) {
            Stop-WithState 12 "missing_android_tools" "sdkmanager could not install the required Android packages"
        }
        Refresh-Tools
        if (-not $HasAvd -and (Test-AvdExists)) {
            $HasAvd = $true
        }
    }

    if (-not $script:Adb -or -not $script:Emulator) {
        Stop-WithState 12 "missing_android_tools" "Android SDK installation completed without adb/emulator executables"
    }

    if (-not $HasAvd) {
        if (-not $InstallMissing) {
            Stop-WithState 11 "missing_avd" "AVD $AvdName is not installed"
        }
        Write-Log "Creating root-capable Google APIs AVD $AvdName ..."
        "no" | & $script:AvdManager create avd --name $AvdName --package $SystemImage --device pixel_6
        if ($LASTEXITCODE -ne 0) {
            Stop-WithState 14 "emulator_start_failed" "avdmanager could not create AVD $AvdName"
        }
    }

    Write-Log "Starting AVD $AvdName ..."
    $logBase = Join-Path ([IO.Path]::GetTempPath()) "shortdrama-dl-$AvdName-emulator"
    try {
        Start-Process -FilePath $script:Emulator -ArgumentList @(
            "@$AvdName", "-no-snapshot", "-writable-system", "-gpu", "auto"
        ) -RedirectStandardOutput "$logBase.out.log" -RedirectStandardError "$logBase.err.log" -WindowStyle Hidden | Out-Null
    } catch {
        Stop-WithState 14 "emulator_start_failed" "Could not start AVD $AvdName: $($_.Exception.Message)"
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($BootTimeout)
    while ([DateTime]::UtcNow -lt $deadline) {
        $ReadySerial = Get-ReadyDevice
        if ($ReadySerial) { break }
        Start-Sleep -Seconds 2
    }
    if (-not $ReadySerial) {
        Stop-WithState 14 "emulator_start_failed" "AVD did not appear in adb within ${BootTimeout}s; see $logBase.err.log"
    }

    Write-Log "Waiting for Android to finish booting ..."
    $booted = ""
    while ([DateTime]::UtcNow -lt $deadline) {
        $booted = ((& $script:Adb -s $ReadySerial shell getprop sys.boot_completed 2>$null) | Out-String).Trim()
        if ($booted -eq "1") { break }
        Start-Sleep -Seconds 3
    }
    if ($booted -ne "1") {
        Stop-WithState 15 "emulator_boot_timeout" "Android did not finish booting within ${BootTimeout}s"
    }
}

Write-Log "Requesting adb root on $ReadySerial ..."
& $script:Adb -s $ReadySerial root 2>$null | Out-Null
Start-Sleep -Seconds 2
& $script:Adb -s $ReadySerial wait-for-device | Out-Null
$deviceId = ((& $script:Adb -s $ReadySerial shell id 2>$null) | Out-String).Trim()
if ($deviceId -notmatch 'uid=0\(') {
    Stop-WithState 16 "root_required" "Device $ReadySerial is not adb-root capable; use a Google APIs AVD, not a Google Play AVD"
}

$fridaPid = ((& $script:Adb -s $ReadySerial shell pidof frida-server 2>$null) | Out-String).Trim()
if (-not $fridaPid) {
    & $script:Adb -s $ReadySerial shell test -x /data/local/tmp/frida-server 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        & $script:Adb -s $ReadySerial shell "nohup /data/local/tmp/frida-server >/dev/null 2>&1 &" 2>$null | Out-Null
        Start-Sleep -Seconds 2
        $fridaPid = ((& $script:Adb -s $ReadySerial shell pidof frida-server 2>$null) | Out-String).Trim()
    }
}

if ($fridaPid) {
    Write-Log "Ready: $ReadySerial, root, frida-server pid $fridaPid"
} else {
    Write-Log "Ready: $ReadySerial, root; frida-server will be checked by the Python runtime"
}
Write-State "ready" @("serial=$ReadySerial")
exit 0
