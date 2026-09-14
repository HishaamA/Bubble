param()
$ErrorActionPreference = 'Stop'
$bubbleRoot = Split-Path -Parent $PSScriptRoot
$dependencyRoot = Join-Path $bubbleRoot '.native-deps'
$sdkRoot = Join-Path $dependencyRoot 'opencv-4.12.0'
$sdkConfig = Join-Path $sdkRoot 'OpenCV-android-sdk/sdk/native/jni/OpenCVConfig.cmake'
$archive = Join-Path $dependencyRoot 'opencv-4.12.0-android-sdk.zip'
$expectedHash = 'fd7f2332331b4eb8b67e55137281cfb16823c9399d90deb9cfa3476783b99e35'
if (-not (Test-Path -LiteralPath $sdkConfig)) {
    New-Item -ItemType Directory -Path $dependencyRoot -Force | Out-Null
    if (-not (Test-Path -LiteralPath $archive)) {
        Invoke-WebRequest -Uri 'https://github.com/opencv/opencv/releases/download/4.12.0/opencv-4.12.0-android-sdk.zip' -OutFile $archive
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
        throw 'OpenCV archive checksum mismatch. The archive was left untouched; inspect it before retrying.'
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $sdkRoot
}
$modelsRoot = Join-Path $bubbleRoot 'android/app/src/main/assets/stitch-models'
$report = Get-Content -LiteralPath (Join-Path $modelsRoot 'model-report.json') -Raw | ConvertFrom-Json
foreach ($model in @(
    @{ Name = 'disk-1024.onnx'; Metadata = $report.extractor },
    @{ Name = 'disk-lightglue.onnx'; Metadata = $report.matcher }
)) {
    $modelPath = Join-Path $modelsRoot $model.Name
    if ((Get-Item -LiteralPath $modelPath).Length -ne $model.Metadata.bytes -or
        (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $model.Metadata.sha256) {
        throw "Bundled model verification failed: $($model.Name). Restore it or run the documented exporter."
    }
}
Write-Output 'Android OpenCV SDK and both bundled offline models are ready. No phone-side download is required.'
