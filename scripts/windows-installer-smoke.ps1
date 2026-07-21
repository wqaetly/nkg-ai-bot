param(
  [Parameter(Position = 0)]
  [string]$Installer
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseRoot = Join-Path $workspace "artifacts\releases"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\NKG AI Bot"
$productKey = "HKCU:\Software\nkg\NKG AI Bot"

if (Test-Path -LiteralPath $uninstallKey) {
  throw "检测到已安装的 NKG AI Bot；为避免覆盖真实安装，请在干净用户环境运行 smoke"
}

$productKeySnapshot = $null
if (Test-Path -LiteralPath $productKey) {
  $registryKey = Get-Item -LiteralPath $productKey
  $productKeySnapshot = @{}
  foreach ($name in $registryKey.GetValueNames()) {
    $productKeySnapshot[$name] = @{
      value = $registryKey.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      kind = $registryKey.GetValueKind($name)
    }
  }
}

if ([string]::IsNullOrWhiteSpace($Installer)) {
  $candidate = Get-ChildItem -LiteralPath $releaseRoot -Recurse -File -Filter "*-setup.exe" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -eq $candidate) { throw "未找到 Release NSIS 安装器" }
  $installerPath = $candidate.FullName
} else {
  $installerPath = (Resolve-Path -LiteralPath $Installer).Path
}

$smokeRoot = Join-Path $workspace "artifacts"
$installDir = Join-Path $smokeRoot "installer-smoke"
if (Test-Path -LiteralPath $installDir) {
  throw "smoke 安装目录已存在，请先确认并清理：$installDir"
}
New-Item -ItemType Directory -Path $installDir | Out-Null
$app = $null

try {
  $installerProcess = Start-Process -FilePath $installerPath -ArgumentList "/S", ("/D=" + $installDir) -PassThru -Wait -WindowStyle Hidden
  if ($installerProcess.ExitCode -ne 0) { throw "NSIS 安装失败，退出码 $($installerProcess.ExitCode)" }

  $executable = Get-ChildItem -LiteralPath $installDir -File -Filter "*.exe" |
    Where-Object { $_.Name -ne "uninstall.exe" } |
    Select-Object -First 1
  if ($null -eq $executable) { throw "安装目录中未找到应用程序：$installDir" }

  # Give Windows Defender/WebView loader time to finish post-install scanning.
  Start-Sleep -Seconds 5
  $app = Start-Process -FilePath $executable.FullName -PassThru -WindowStyle Normal
  Start-Sleep -Seconds 8
  $app.Refresh()
  if ($app.HasExited) { throw "安装后的应用过早退出，退出码 $($app.ExitCode)" }

  [ordered]@{
    installer = $installerPath | Split-Path -Leaf
    executable = $executable.Name
    launchAliveMs = 8000
    status = "passed"
  } | ConvertTo-Json
} finally {
  if ($null -ne $app) {
    $app.Refresh()
    if (-not $app.HasExited) {
      Stop-Process -Id $app.Id -Force
      Start-Sleep -Seconds 1
    }
  }

  $uninstaller = Join-Path $installDir "uninstall.exe"
  if (Test-Path -LiteralPath $uninstaller) {
    Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -WindowStyle Hidden
    Start-Sleep -Seconds 5
  }

  $resolvedInstallDir = [IO.Path]::GetFullPath($installDir)
  $resolvedSmokeRoot = [IO.Path]::GetFullPath($smokeRoot) + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedInstallDir.StartsWith($resolvedSmokeRoot) -or
      (Split-Path $resolvedInstallDir -Leaf) -ne "installer-smoke") {
    throw "拒绝清理非 smoke 临时目录：$resolvedInstallDir"
  }
  if (Test-Path -LiteralPath $resolvedInstallDir) {
    Remove-Item -LiteralPath $resolvedInstallDir -Recurse -Force
  }

  if (Test-Path -LiteralPath $productKey) {
    Remove-Item -LiteralPath $productKey -Recurse -Force
  }
  if ($null -ne $productKeySnapshot) {
    New-Item -Path $productKey -Force | Out-Null
    $registryKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\nkg\NKG AI Bot", $true)
    try {
      foreach ($name in $productKeySnapshot.Keys) {
        $entry = $productKeySnapshot[$name]
        $registryKey.SetValue($name, $entry.value, $entry.kind)
      }
    } finally {
      $registryKey.Dispose()
    }
  }
}
