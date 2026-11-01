<#
.SYNOPSIS
    安装运行本程序所需的第三方依赖（ffmpeg / Node.js / CPython / yt-dlp / PO Token 插件）。

.DESCRIPTION
    本仓库不包含任何二进制文件（约 300 MB），克隆后跑一次这个脚本即可把 runtime\ 与 bin\
    补齐。所有下载都来自官方或国内镜像，可用 -Force 重新拉取。

    组装出来的目录结构与 Release 便携包一致：
        bin\ffmpeg.exe
        runtime\node\node.exe
        runtime\python\   （含 pip 版 yt-dlp 与 bgutil 插件）

    PO Token 服务端（runtime\pot-server）**无法自动构建**：上游 v2 不发布源码包，
    其依赖链需要编译原生模块。详见末尾提示。

.PARAMETER NodeVersion
    要下载的 Node.js 版本，默认 v24.21.0。可用 `node -v` 的格式，也可写 v22 系列。

.PARAMETER PythonVersion
    要下载的 CPython 版本（取自 NuGet 的独立发行包），默认 3.13.14。

.PARAMETER PythonMirror
    pip 使用的镜像，默认阿里云。想用官方源就传空字符串。

.PARAMETER Force
    已存在的组件也重新下载覆盖。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-deps.ps1

.EXAMPLE
    # 只补 python 与 yt-dlp，跳过 ffmpeg 和 node
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-deps.ps1 -SkipFfmpeg -SkipNode
#>
[CmdletBinding()]
param(
    [string]$NodeVersion = 'v24.21.0',
    [string]$PythonVersion = '3.13.14',
    [string]$PythonMirror = 'https://mirrors.aliyun.com/pypi/simple/',
    [switch]$SkipFfmpeg,
    [switch]$SkipNode,
    [switch]$SkipPython,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11

$Root     = Split-Path -Parent $PSScriptRoot
$BinDir   = Join-Path $Root 'bin'
$RunDir   = Join-Path $Root 'runtime'
$Tmp      = Join-Path ([IO.Path]::GetTempPath()) ('ytdl-deps-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))

$script:Results = @()

function Write-Step($n, $msg) {
    Write-Host ''
    Write-Host ("[{0}] {1}" -f $n, $msg) -ForegroundColor Cyan
}

function Write-Ok($msg)   { Write-Host "      OK   $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "      WARN $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "           $msg" -ForegroundColor DarkGray }

function Add-Result($name, $ok, $detail) {
    $script:Results += [pscustomobject]@{ 组件 = $name; 状态 = $(if ($ok) { 'OK' } else { 'MISSING' }); 说明 = $detail }
}

function Get-File($url, $dest) {
    Write-Info "下载 $url"
    $parent = Split-Path -Parent $dest
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

    $ok = $false
    for ($i = 1; $i -le 3 -and -not $ok; $i++) {
        try {
            # 优先 curl.exe：对国内镜像和大文件更稳，且不受 Invoke-WebRequest 的缓冲区限制
            $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
            if ($curl) {
                & $curl.Source -L --fail --retry 2 --connect-timeout 20 -o $dest $url
                if ($LASTEXITCODE -eq 0 -and (Test-Path $dest) -and (Get-Item $dest).Length -gt 0) { $ok = $true; break }
            }
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 300
            if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 0) { $ok = $true }
        }
        catch {
            Write-Warn "第 $i 次下载失败：$($_.Exception.Message)"
            Start-Sleep -Seconds 2
        }
    }
    if (-not $ok) { throw "下载失败：$url" }
    Write-Info ("        完成 {0:N1} MB" -f ((Get-Item $dest).Length / 1MB))
}

function Expand-Zip($zip, $dest) {
    if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    # ExtractToDirectory 比 Expand-Archive 快，且不受 2 GB / 路径深度限制的影响小
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)
}

function Remove-Tree($path) {
    if (Test-Path $path) {
        Write-Info "删除旧目录 $path"
        Remove-Item -LiteralPath $path -Recurse -Force
    }
}

Write-Host ''
Write-Host '===============================================' -ForegroundColor DarkCyan
Write-Host '  YouTube 下载器 —— 依赖安装' -ForegroundColor White
Write-Host '===============================================' -ForegroundColor DarkCyan
Write-Info "程序目录：$Root"
Write-Info "Node.js ：$NodeVersion"
Write-Info "CPython ：$PythonVersion"

New-Item -ItemType Directory -Force -Path $BinDir, $RunDir, $Tmp | Out-Null

try {
    # ---------------------------------------------------------------- 1. ffmpeg
    Write-Step 1 'ffmpeg'
    $ffmpeg = Join-Path $BinDir 'ffmpeg.exe'
    if ($SkipFfmpeg) {
        Write-Info '已按 -SkipFfmpeg 跳过'
        Add-Result 'ffmpeg' (Test-Path $ffmpeg) $(if (Test-Path $ffmpeg) { '已存在（跳过下载）' } else { '被跳过，需自行放置' })
    }
    elseif ((Test-Path $ffmpeg) -and -not $Force) {
        Write-Ok "已存在：$ffmpeg"
        Add-Result 'ffmpeg' $true '已存在'
    }
    else {
        $zip = Join-Path $Tmp 'ffmpeg.zip'
        Get-File 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $zip
        $x = Join-Path $Tmp 'ffmpeg'
        Expand-Zip $zip $x
        $src = Get-ChildItem -Path $x -Recurse -Filter 'ffmpeg.exe' -File | Select-Object -First 1
        if (-not $src) { throw '压缩包里没找到 ffmpeg.exe' }
        Copy-Item $src.FullName $ffmpeg -Force
        Write-Ok ("装好 {0:N1} MB" -f ((Get-Item $ffmpeg).Length / 1MB))
        Add-Result 'ffmpeg' $true 'gyan.dev essentials build'
    }

    # ---------------------------------------------------------------- 2. Node.js
    Write-Step 2 'Node.js'
    $node = Join-Path $RunDir 'node\node.exe'
    if ($SkipNode) {
        Write-Info '已按 -SkipNode 跳过'
        Add-Result 'Node.js' (Test-Path $node) $(if (Test-Path $node) { '已存在（跳过下载）' } else { '被跳过，将使用系统 node' })
    }
    elseif ((Test-Path $node) -and -not $Force) {
        Write-Ok "已存在：$node"
        Add-Result 'Node.js' $true '已存在'
    }
    else {
        $zip = Join-Path $Tmp 'node.zip'
        $url = "https://registry.npmmirror.com/-/binary/node/$NodeVersion/node-$NodeVersion-win-x64.zip"
        Get-File $url $zip
        $x = Join-Path $Tmp 'node'
        Expand-Zip $zip $x
        $src = Get-ChildItem -Path $x -Recurse -Filter 'node.exe' -File | Select-Object -First 1
        if (-not $src) { throw '压缩包里没找到 node.exe' }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $node) | Out-Null
        Copy-Item $src.FullName $node -Force
        $v = & $node --version
        Write-Ok "$node  ($v)"
        Add-Result 'Node.js' $true $v
    }

    # ---------------------------------------------------------------- 3. CPython
    Write-Step 3 'CPython'
    $py = Join-Path $RunDir 'python\python.exe'
    if ($SkipPython) {
        Write-Info '已按 -SkipPython 跳过'
        Add-Result 'CPython' (Test-Path $py) '已按 -SkipPython 跳过'
    }
    elseif ((Test-Path $py) -and -not $Force) {
        Write-Ok "已存在：$py"
        Add-Result 'CPython' $true '已存在'
    }
    else {
        $nupkg = Join-Path $Tmp 'python.nupkg'
        Get-File "https://www.nuget.org/api/v2/package/python/$PythonVersion" $nupkg
        $x = Join-Path $Tmp 'python'
        # NuGet 包本质就是 zip，改个后缀才能用 ZipFile 解
        $asZip = Join-Path $Tmp 'python.zip'
        Copy-Item $nupkg $asZip -Force
        Expand-Zip $asZip $x
        $tools = Join-Path $x 'tools'
        if (-not (Test-Path (Join-Path $tools 'python.exe'))) { throw 'NuGet 包里没找到 tools\python.exe' }

        $dest = Join-Path $RunDir 'python'
        if (Test-Path $dest) { Remove-Tree $dest }
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Copy-Item (Join-Path $tools '*') $dest -Recurse -Force
        $v = & $py -V
        Write-Ok "$py  ($v)"
        Add-Result 'CPython' $true $v
    }

    # ---------------------------------------------------------------- 4. yt-dlp
    Write-Step 4 'yt-dlp（pip 版）与 PO Token 插件'
    if ($SkipPython -or -not (Test-Path $py)) {
        Write-Warn '没有可用的 CPython，跳过'
        Add-Result 'yt-dlp' $false '缺少 CPython'
    }
    else {
        $pipArgs = @('-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', '--no-warn-script-location',
                     'yt-dlp', 'bgutil-ytdlp-pot-provider')
        if ($PythonMirror) { $pipArgs += @('-i', $PythonMirror) }

        Write-Info ('执行：python.exe ' + ($pipArgs -join ' '))
        # pip 会把版本提示写到 stderr，PowerShell 在 -File 模式下会把它当异常噪音，这里合并后原样转出
        $out = & $py @pipArgs 2>&1
        $out | Where-Object { $_ -match 'Successfully|Requirement already|ERROR' } | ForEach-Object { Write-Info $_ }
        if ($LASTEXITCODE -ne 0) { throw "pip 安装失败（退出码 $LASTEXITCODE）" }

        $ver = (& $py -m yt_dlp --version) 2>$null
        $pluginOk = Test-Path (Join-Path $RunDir 'python\Lib\site-packages\yt_dlp_plugins\extractor\getpot_bgutil_script.py')
        Write-Ok "yt-dlp $ver"
        if ($pluginOk) { Write-Ok 'bgutil 插件已就位' } else { Write-Warn 'bgutil 插件缺失，PO Token 将不可用' }
        Add-Result 'yt-dlp' $true "版本 $ver"
        Add-Result 'PO Token 插件' $pluginOk $(if ($pluginOk) { 'yt_dlp_plugins\extractor\getpot_bgutil_script.py' } else { '缺失' })
    }

    # ---------------------------------------------------------------- 5. POT 服务端
    Write-Step 5 'PO Token 服务端（可选，检查）'
    $potScript = Join-Path $RunDir 'pot-server\build\generate_once.js'
    if (Test-Path $potScript) {
        Write-Ok "已存在：$potScript"
        Add-Result 'PO Token 服务端' $true 'script 模式可用'
    }
    else {
        Write-Warn '未找到 runtime\pot-server\build\generate_once.js'
        Write-Info '这一项无法自动安装（上游 v2 只发布编译产物，依赖链需编译原生模块）。'
        Write-Info '三个办法，任选其一：'
        Write-Info '  1) 直接用 Release 里的便携包（自带 pot-server），最省事'
        Write-Info '  2) 从别的机器上把整个 runtime\pot-server 目录拷过来'
        Write-Info '  3) 自己构建：git clone https://github.com/Brainicism/bgutil-ytdlp-pot-provider'
        Write-Info '     进 server\ 目录 npm install，再想办法产出 build\generate_once.js'
        Write-Info '没有它也能跑，但 YouTube 多数视频只会给到 360p。'
        Add-Result 'PO Token 服务端' $false '缺失（详见上方说明）'
    }
}
catch {
    Write-Host ''
    Write-Warn "安装中断：$($_.Exception.Message)"
    Write-Host ''
}
finally {
    if (Test-Path $Tmp) { Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

# -------------------------------------------------------------------- 汇总
Write-Host ''
Write-Host '-----------------------------------------------' -ForegroundColor DarkCyan
$script:Results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
$missing = @($script:Results | Where-Object { $_.状态 -ne 'OK' })
if ($missing.Count -eq 0) {
    Write-Host '依赖齐了，双击「启动下载器.bat」即可。' -ForegroundColor Green
}
else {
    Write-Host ("有 {0} 项没装好，见上表最后一列。" -f $missing.Count) -ForegroundColor Yellow
}
Write-Host '想复查随时跑：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-deps.ps1' -ForegroundColor DarkGray
Write-Host '-----------------------------------------------' -ForegroundColor DarkCyan
