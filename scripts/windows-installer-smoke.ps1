param(
  [Parameter(Position = 0)]
  [string]$Installer
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseRoot = Join-Path $workspace "artifacts\releases"
$productKey = "HKCU:\Software\nkg\NKG AI Bot"

function Find-InstalledNkgAiBot {
  $roots = @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  return Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq "NKG AI Bot" } |
    Select-Object -First 1
}

if ($null -ne (Find-InstalledNkgAiBot)) {
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
  $candidate = Get-ChildItem -LiteralPath $releaseRoot -Recurse -File -Filter "*.msi" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -eq $candidate) { throw "未找到 Release MSI 安装器" }
  $installerPath = $candidate.FullName
} else {
  $installerPath = (Resolve-Path -LiteralPath $Installer).Path
}

$smokeRoot = Join-Path $workspace "artifacts"
$installDir = Join-Path $smokeRoot "installer-smoke-msi"
if (Test-Path -LiteralPath $installDir) {
  throw "smoke 安装目录已存在，请先确认并清理：$installDir"
}
New-Item -ItemType Directory -Path $installDir | Out-Null
$app = $null

try {
  $installArgs = @("/i", "`"$installerPath`"", "/qn", "/norestart", "INSTALLDIR=`"$installDir`"")
  $installerProcess = Start-Process -FilePath "msiexec.exe" -ArgumentList $installArgs -PassThru -Wait -WindowStyle Hidden
  if ($installerProcess.ExitCode -ne 0) { throw "MSI 安装失败，退出码 $($installerProcess.ExitCode)" }

  $executable = Get-ChildItem -LiteralPath $installDir -File -Filter "*.exe" |
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

  if ($null -ne (Find-InstalledNkgAiBot)) {
    $uninstallArgs = @("/x", "`"$installerPath`"", "/qn", "/norestart")
    $uninstaller = Start-Process -FilePath "msiexec.exe" -ArgumentList $uninstallArgs -PassThru -Wait -WindowStyle Hidden
    if ($uninstaller.ExitCode -ne 0) { throw "MSI 卸载失败，退出码 $($uninstaller.ExitCode)" }
    Start-Sleep -Seconds 3
  }

  $resolvedInstallDir = [IO.Path]::GetFullPath($installDir)
  $resolvedSmokeRoot = [IO.Path]::GetFullPath($smokeRoot) + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedInstallDir.StartsWith($resolvedSmokeRoot) -or
      (Split-Path $resolvedInstallDir -Leaf) -ne "installer-smoke-msi") {
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
