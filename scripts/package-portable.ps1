<#
.SYNOPSIS
    打一个便携包（zip），解压即用，不需要装 Node.js / Python / ffmpeg。

.DESCRIPTION
    把整个程序目录（源码 + bin\ffmpeg.exe + runtime\node + runtime\python + runtime\pot-server）
    复制到一个临时目录，剔除不应该随包分发的东西（git 元数据、旧 venv、本机配置、下载产物、
    重复的嵌套 build），再压缩成 dist\YouTube下载器-v<版本>-portable.zip。

    便携包**不进 git**，上传到 GitHub Release 作为附件。

.PARAMETER OutputDir
    产物目录，默认 dist。

.PARAMETER KeepStage
    保留临时组装目录，便于排查（正常情况下会删掉）。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\package-portable.ps1

.EXAMPLE
    npm run package
#>
[CmdletBinding()]
param(
    [string]$OutputDir = 'dist',
    [switch]$KeepStage
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root  = Split-Path -Parent $PSScriptRoot
$Name  = 'YouTube下载器'

# ---------------------------------------------------------------- 版本号
$pkg = Join-Path $Root 'package.json'
$ver = '1.0.0'
if (Test-Path $pkg) {
    try {
        $ver = (Get-Content $pkg -Raw -Encoding UTF8 | ConvertFrom-Json).version
        if (-not $ver) { $ver = '1.0.0' }
    }
    catch { }
}

$OutRoot = if ([IO.Path]::IsPathRooted($OutputDir)) { $OutputDir } else { Join-Path $Root $OutputDir }
New-Item -ItemType Directory -Force -Path $OutRoot | Out-Null

$StageRoot = Join-Path $OutRoot ('_stage-' + [Guid]::NewGuid().ToString('N').Substring(0, 6))
$Stage     = Join-Path $StageRoot $Name
$ZipPath   = Join-Path $OutRoot ("{0}-v{1}-portable.zip" -f $Name, $ver)

function Write-Step($n, $msg) {
    Write-Host ''
    Write-Host ("[{0}] {1}" -f $n, $msg) -ForegroundColor Cyan
}
function Write-Ok($msg)   { Write-Host "      OK   $msg" -ForegroundColor Green }
function Write-Info($msg) { Write-Host "           $msg" -ForegroundColor DarkGray }

function Get-TreeSize($path) {
    $sum = 0; $n = 0
    Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
        $sum += $_.Length; $n++
    }
    return [pscustomobject]@{ Bytes = $sum; Files = $n }
}

Write-Host ''
Write-Host '===============================================' -ForegroundColor DarkCyan
Write-Host "  YouTube 下载器 —— 打便携包  v$ver" -ForegroundColor White
Write-Host '===============================================' -ForegroundColor DarkCyan
Write-Info "源目录：$Root"
Write-Info "产物  ：$ZipPath"

# 前置检查：缺东西打出来的包就是坏的
$required = @(
    'server.js',
    'public\index.html',
    'bin\ffmpeg.exe',
    'runtime\node\node.exe',
    'runtime\python\python.exe',
    'runtime\python\Lib\site-packages\yt_dlp\__init__.py',
    'runtime\pot-server\build\generate_once.js'
)
$missing = @()
foreach ($r in $required) {
    if (-not (Test-Path (Join-Path $Root $r))) { $missing += $r }
}
if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Host '  以下必需文件缺失，先跑 scripts\install-deps.ps1：' -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "    - $_" -ForegroundColor Red }
    exit 1
}
Write-Ok '必需文件齐全'

try {
    # ------------------------------------------------------------ 1. 复制
    Write-Step 1 '组装临时目录'
    New-Item -ItemType Directory -Force -Path $Stage | Out-Null

    # 目录级排除：git 元数据、会话记忆、临时产物、旧 venv、重复嵌套 build
    $xDirs = @(
        (Join-Path $Root '.git'),
        (Join-Path $Root '.dsh'),
        (Join-Path $Root '.vscode'),
        (Join-Path $Root '.idea'),
        (Join-Path $Root '_diag'),
        (Join-Path $Root '_tmp_fix'),
        (Join-Path $Root 'dist'),
        (Join-Path $Root 'downloads'),
        (Join-Path $Root 'runtime\venv'),
        (Join-Path $Root 'runtime\pot-server\build\build'),
        (Join-Path $Root 'node_modules')
    ) | Where-Object { Test-Path $_ }

    $robocopyArgs = @($Root, $Stage, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1', '/MT:8')
    if ($xDirs.Count -gt 0) { $robocopyArgs += '/XD'; $robocopyArgs += $xDirs }
    $robocopyArgs += '/XF'
    $robocopyArgs += @('config.json', '*.log', '_diagnose_result.txt')

    Write-Info ('robocopy 参数：/E /XD ' + ($xDirs.Count) + ' 项 /XF 3 类')
    & robocopy @robocopyArgs | Out-Null
    $rc = $LASTEXITCODE
    # robocopy：0-7 均代表成功（1=有复制，3=有复制+有额外项……），>=8 才是失败
    if ($rc -ge 8) { throw "robocopy 失败，退出码 $rc" }
    Write-Ok '复制完成'

    # ------------------------------------------------------------ 2. 补丁
    Write-Step 2 '整理包内结构'
    $dl = Join-Path $Stage 'downloads'
    if (-not (Test-Path $dl)) { New-Item -ItemType Directory -Force -Path $dl | Out-Null }
    Get-ChildItem $dl -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Write-Ok 'downloads 已清空'

    # 即便上面 /XF 漏了，这里再兜一次：本机配置绝不随包
    $cfg = Join-Path $Stage 'config.json'
    if (Test-Path $cfg) { Remove-Item $cfg -Force; Write-Ok '已剔除本机 config.json' }

    # ------------------------------------------------------------ 3. 说明书
    Write-Step 3 '生成使用说明.txt'
    $guide = @'
YouTube 下载器 v__VER__
========================================

【怎么用】
  1. 双击「启动下载器.bat」
  2. 浏览器会自动打开 http://127.0.0.1:8808
     （没自动打开就手动访问这个地址）
  3. 粘贴 YouTube 链接 → 点「解析」→ 选画质 → 下载
  4. 命令行窗口保持开着就是服务在跑，Ctrl+C 或关窗口即停止

【要不要装东西】
  不用。Node.js、Python、yt-dlp、ffmpeg 都在本目录里，换电脑解压即用。
  也不写注册表、不装服务，删掉整个目录就等于卸载干净。

【下载的文件在哪】
  默认在程序目录下的 downloads 文件夹。
  想改：界面右上角「设置」→ 下载目录（建议写绝对路径）。

【升级 yt-dlp】
  界面「设置」里有「更新 yt-dlp」按钮，走 pip + 阿里云镜像。
  版本超过 45 天会亮黄标——YouTube 改版很快，旧版容易 403 或只给 360p。

【几个注意事项】
  - 不要放在 OneDrive / 坚果云等同步盘里，几千个文件的实时同步会拖慢启动
  - 路径可以含中文和空格，没问题
  - 只监听 127.0.0.1，本机以外访问不到，无需担心暴露
  - Windows 10/11 均可；不需要管理员权限
  - 杀毒软件可能误报（未签名的 ffmpeg/node/python），把目录加白名单即可

【出问题了】
  docs\常见问题.md      按症状查的排障手册
  docs\技术决策.md      「为什么这么设计」，改代码前必读
  docs\第三方组件与许可.md  包内各组件的来源与许可证
  端口被占用时可换端口：命令行里 set PORT=9000 后再启动

【许可】
  本项目自写代码（server.js / public / tools / 脚本与文档）为 MIT。
  包内的 ffmpeg、yt-dlp、bgutil-ytdlp-pot-provider、Node.js、CPython 各自遵循
  其原始许可证（其中 ffmpeg 与 bgutil 为 GPLv3），详见 docs\第三方组件与许可.md。

【免责】
  仅供个人学习与技术研究，请勿用于商业用途或大规模抓取。
  下载内容的版权归原始权利人所有，使用者自行承担合规责任。
'@
    $guide = $guide.Replace('__VER__', $ver).Replace("`r`n", "`n").Replace("`n", "`r`n")
    $guidePath = Join-Path $Stage '使用说明.txt'
    # UTF-8 BOM：Windows 记事本才不会把中文显示成乱码
    [IO.File]::WriteAllText($guidePath, $guide, (New-Object System.Text.UTF8Encoding $true))
    Write-Ok '使用说明.txt（UTF-8 BOM + CRLF）'

    # ------------------------------------------------------------ 4. 自检
    Write-Step 4 '包内自检'
    $stillBad = @()
    if (Test-Path (Join-Path $Stage 'runtime\venv')) { $stillBad += 'runtime\venv 没被排除' }
    if (Test-Path (Join-Path $Stage 'config.json')) { $stillBad += 'config.json 没被排除' }
    if (Test-Path (Join-Path $Stage '.git')) { $stillBad += '.git 没被排除' }
    if (-not (Test-Path (Join-Path $Stage '使用说明.txt'))) { $stillBad += '使用说明.txt 缺失' }
    if ($stillBad.Count -gt 0) { throw ("自检失败：" + ($stillBad -join '；')) }

    $size = Get-TreeSize $Stage
    Write-Ok ("{0} 个文件，{1:N1} MB" -f $size.Files, ($size.Bytes / 1MB))
    Write-Ok '排除项检查通过（无 venv / config.json / .git）'

    # ------------------------------------------------------------ 5. 压缩
    Write-Step 5 '压缩'
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $sw = [Diagnostics.Stopwatch]::StartNew()
    [IO.Compression.ZipFile]::CreateFromDirectory(
        $StageRoot,
        $ZipPath,
        [IO.Compression.CompressionLevel]::Optimal,
        $false)
    $sw.Stop()
    $zipMB = (Get-Item $ZipPath).Length / 1MB
    Write-Ok ("{0}  （{1:N1} MB，压缩率 {2:P0}，耗时 {3:N0} 秒）" -f `
            (Split-Path -Leaf $ZipPath), $zipMB, ($zipMB * 1MB / $size.Bytes), $sw.Elapsed.TotalSeconds)
}
catch {
    Write-Host ''
    Write-Host "  打包失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    if (-not $KeepStage -and (Test-Path $StageRoot)) {
        Remove-Item -LiteralPath $StageRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    elseif ($KeepStage) {
        Write-Info "临时目录保留在：$StageRoot"
    }
}

Write-Host ''
Write-Host '-----------------------------------------------' -ForegroundColor DarkCyan
Write-Host '  下一步：' -ForegroundColor White
Write-Host "    1. 解压到另一个目录，双击「启动下载器.bat」实测一遍" -ForegroundColor DarkGray
Write-Host '       （至少跑一次「解析」和一次「下载」，只测解析会漏掉 spawn 那条路径）' -ForegroundColor DarkGray
Write-Host "    2. 把 zip 传到 GitHub Release 附件：$ZipPath" -ForegroundColor DarkGray
Write-Host '    3. zip 不进 git，.gitignore 里已经排除了 dist/' -ForegroundColor DarkGray
Write-Host '-----------------------------------------------' -ForegroundColor DarkCyan
