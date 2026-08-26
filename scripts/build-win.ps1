param(
  [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packagePath = Join-Path $projectRoot 'package.json'
$package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
$electronDist = Join-Path $projectRoot 'node_modules\electron\dist'
$electronExe = Join-Path $electronDist 'electron.exe'
$iconGenerator = Join-Path $projectRoot 'scripts\icon-generator'
$iconPath = Join-Path $projectRoot 'src\assets\app-icon.ico'
$iconStampScript = Join-Path $projectRoot 'scripts\set-win-icon.ps1'

if (-not (Test-Path -LiteralPath $electronExe)) {
  throw 'Electron runtime is missing. Run npm install before building.'
}

$iconProcess = Start-Process -FilePath $electronExe -ArgumentList "`"$iconGenerator`"" -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait -PassThru
if ($iconProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $iconPath)) {
  throw "App icon generation failed with exit code $($iconProcess.ExitCode)."
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path (Split-Path $projectRoot -Parent) 'releases'
}

$outputRootPath = [System.IO.Path]::GetFullPath($OutputRoot)
$artifactName = "WorkHelper-$($package.version)-win-x64"
$outputDir = Join-Path $outputRootPath $artifactName
$zipPath = Join-Path $outputRootPath "$artifactName.zip"

New-Item -ItemType Directory -Force -Path $outputRootPath | Out-Null

foreach ($target in @($outputDir, $zipPath)) {
  if (-not (Test-Path -LiteralPath $target)) { continue }
  $resolvedTarget = [System.IO.Path]::GetFullPath($target)
  if (-not $resolvedTarget.StartsWith($outputRootPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace a build outside the output directory: $resolvedTarget"
  }
  Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
}

Copy-Item -LiteralPath $electronDist -Destination $outputDir -Recurse
Rename-Item -LiteralPath (Join-Path $outputDir 'electron.exe') -NewName 'WorkHelper.exe'
$exePath = Join-Path $outputDir 'WorkHelper.exe'
& $iconStampScript -ExePath $exePath -IconPath $iconPath

$appDir = Join-Path $outputDir 'resources\app'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'src') -Destination $appDir -Recurse
Copy-Item -LiteralPath $packagePath -Destination $appDir

$revision = (& git -C $projectRoot rev-parse --short HEAD).Trim()
$dirty = [bool](& git -C $projectRoot status --porcelain --untracked-files=normal)
$buildInfo = [ordered]@{
  version = $package.version
  revision = $revision
  includesWorkingTreeChanges = $dirty
  builtAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
  platform = 'win32-x64'
  icon = 'src/assets/app-icon.ico'
}
$buildInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputDir 'build-info.json') -Encoding UTF8

Compress-Archive -LiteralPath $outputDir -DestinationPath $zipPath -CompressionLevel Optimal

Write-Output "BUILD_DIR=$outputDir"
Write-Output "BUILD_EXE=$exePath"
Write-Output "BUILD_ZIP=$zipPath"
Write-Output "BUILD_VERSION=$($package.version)"
