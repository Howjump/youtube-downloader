<#
.SYNOPSIS
    体检：逐项检查运行本程序所需的文件与依赖，输出一张状态表。

.DESCRIPTION
    只读脚本，不下载、不修改任何文件。检查项与「启动下载器.bat」的实际查找顺序保持一致，
    所以这里的结论就是启动时会发生什么。

    退出码：0 = 全部可用；1 = 有 FAIL 项（缺东西，起不来或会明显降级）。

.PARAMETER Quiet
    只输出失败项，用于脚本里调用。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-deps.ps1
#>
[CmdletBinding()]
param([switch]$Quiet)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Root   = Split-Path -Parent $PSScriptRoot
$BinDir = Join-Path $Root 'bin'
$RunDir = Join-Path $Root 'runtime'
$script:Rows = @()

function Add-Check($item, $status, $detail) {
    $script:Rows += [pscustomobject]@{ 检查项 = $item; 状态 = $status; 详情 = $detail }
}
function Get-DisplayWidth($s) {
    $w = 0
    foreach ($ch in $s.ToCharArray()) {
        if ([int]$ch -gt 0x2E80) { $w += 2 } else { $w += 1 }
    }
    return $w
}
function Pad-Display($s, $width) {
    $pad = $width - (Get-DisplayWidth $s)
    if ($pad -lt 0) { $pad = 0 }
    return $s + (' ' * $pad)
}
function Get-Color($status) {
    switch ($status) {
        'OK'   { 'Green' }
        'WARN' { 'Yellow' }
        default { 'Red' }
    }
}
function Get-FirstLine($exe, $argList) {
    try {
        $o = & $exe $argList 2>&1
        if ($o) { return ($o | Select-Object -First 1).ToString().Trim() }
    }
    catch { }
    return ''
}
function Test-Port($port) {
    $conn = $null
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $conn = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -eq $port
    }
    if (-not $conn) {
        $ns = netstat -ano 2>$null | Select-String -Pattern (":$port\s+\S+\s+LISTENING")
        if ($ns) { return $true }
        return $false
    }
    return $true
}

# ------------------------------------------------------------------ 1. 程序本体
$sj = Join-Path $Root 'server.js'
if (Test-Path $sj) {
    $lines = @(Get-Content $sj -ErrorAction SilentlyContinue).Count
    Add-Check 'server.js' 'OK' "$lines 行，$([Math]::Round((Get-Item $sj).Length / 1KB)) KB"
}
else { Add-Check 'server.js' 'FAIL' '缺失，目录不完整' }
foreach ($f in @('public\index.html', 'package.json')) {
    if (Test-Path (Join-Path $Root $f)) { Add-Check $f 'OK' '存在' }
    else { Add-Check $f 'FAIL' '缺失，目录不完整' }
}

# ------------------------------------------------------------------ 2. Node.js
$node = $null
$candidates = @(
    (Join-Path $RunDir 'node\node.exe'),
    (Join-Path $BinDir 'node.exe'),
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:USERPROFILE 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
)
foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { $node = $c; break }
}
if (-not $node) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
}
if ($node) {
    $v = Get-FirstLine $node '--version'
    if ($v) {
        $major = 0
        if ($v -match 'v(\d+)') { $major = [int]$Matches[1] }
        if ($major -ge 18) { Add-Check 'Node.js' 'OK' "$v  ($node)" }
        else { Add-Check 'Node.js' 'WARN' "$v 太旧，需要 >= 18" }
    }
    else { Add-Check 'Node.js' 'FAIL' "找到了但跑不起来：$node" }
}
else {
    Add-Check 'Node.js' 'FAIL' '未找到（装 Node.js LTS，或跑 scripts\install-deps.ps1）'
}

# ------------------------------------------------------------------ 3. ffmpeg
$ff = Join-Path $BinDir 'ffmpeg.exe'
if (Test-Path $ff) {
    $v = Get-FirstLine $ff '-version'
    $mb = [Math]::Round((Get-Item $ff).Length / 1MB, 1)
    if ($v -match 'ffmpeg version (\S+)') { Add-Check 'ffmpeg' 'OK' "$($Matches[1])  ($mb MB)" }
    elseif ($v) { Add-Check 'ffmpeg' 'OK' "$mb MB" }
    else { Add-Check 'ffmpeg' 'FAIL' '存在但无法执行（可能被杀软拦了）' }
}
else {
    Add-Check 'ffmpeg' 'FAIL' '缺 bin\ffmpeg.exe（合并/转码必需）'
}

# ------------------------------------------------------------------ 4. CPython + yt-dlp
$py = Join-Path $RunDir 'python\python.exe'
$ytdlpVer = $null
if (Test-Path $py) {
    $pv = Get-FirstLine $py '-V'
    Add-Check 'CPython' 'OK' $pv
    $ytdlpVer = Get-FirstLine $py @('-m', 'yt_dlp', '--version')
    if ($ytdlpVer -match '^\d{4}\.\d{1,2}\.\d{1,2}') {
        $age = ''
        $dt = [datetime]::MinValue
        if ([datetime]::TryParseExact($ytdlpVer, 'yyyy.M.d', $null, 'None', [ref]$dt)) {
            $days = ([datetime]::Now.Date - $dt.Date).Days
            if ($days -gt 45) {
                Add-Check 'yt-dlp' 'WARN' "$ytdlpVer —— 已 $days 天未更新，建议升级（YouTube 改版很快）"
            }
            else {
                Add-Check 'yt-dlp' 'OK' "$ytdlpVer（$days 天前发布）"
            }
        }
        else { Add-Check 'yt-dlp' 'OK' $ytdlpVer }
    }
    else {
        $fallback = Join-Path $RunDir 'venv\Scripts\yt-dlp.exe'
        if (Test-Path $fallback) { Add-Check 'yt-dlp' 'WARN' "pip 版不可用，将退回 $fallback" }
        elseif (Test-Path (Join-Path $BinDir 'yt-dlp.exe')) { Add-Check 'yt-dlp' 'WARN' 'pip 版不可用，只能退回 bin\yt-dlp.exe（独立版不加载插件，拿不到 PO Token）' }
        else { Add-Check 'yt-dlp' 'FAIL' '找不到任何可用的 yt-dlp' }
    }
}
else {
    Add-Check 'CPython' 'WARN' '缺 runtime\python\python.exe，将退回 bin\yt-dlp.exe（会掉到 360p）'
}

# ------------------------------------------------------------------ 5. PO Token
$plugin = Join-Path $RunDir 'python\Lib\site-packages\yt_dlp_plugins\extractor\getpot_bgutil_script.py'
if (Test-Path $plugin) { Add-Check 'POT 插件' 'OK' 'bgutil 插件已安装' }
else { Add-Check 'POT 插件' 'FAIL' '缺 bgutil 插件（pip install bgutil-ytdlp-pot-provider）' }

$potScript = Join-Path $RunDir 'pot-server\build\generate_once.js'
if (Test-Path $potScript) {
    $nm = Join-Path $RunDir 'pot-server\node_modules'
    if (Test-Path $nm) {
        $cnt = (Get-ChildItem $nm -Directory -ErrorAction SilentlyContinue | Measure-Object).Count
        Add-Check 'POT 服务端' 'OK' "script 模式可用（node_modules $cnt 个包）"
    }
    else { Add-Check 'POT 服务端' 'WARN' 'generate_once.js 在，但 node_modules 缺失，可能跑不起来' }
}
else {
    Add-Check 'POT 服务端' 'FAIL' '缺 runtime\pot-server\build\generate_once.js —— 多数视频只会给 360p'
}

# ------------------------------------------------------------------ 6. 运行时状态
$cfg = Join-Path $Root 'config.json'
if (Test-Path $cfg) {
    try {
        $c = Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json
        $dl = $c.downloadDir
        if (-not $dl) { $dl = 'downloads' }
        Add-Check 'config.json' 'OK' "下载目录：$dl"
    }
    catch { Add-Check 'config.json' 'WARN' '存在但 JSON 解析失败，程序会回落到默认配置' }
}
else { Add-Check 'config.json' 'OK' '尚未生成（首次启动自动创建，用默认值）' }

if (Test-Port 8808) { Add-Check '端口 8808' 'WARN' '已在监听——服务可能已经在跑' }
else { Add-Check '端口 8808' 'OK' '空闲' }
if (Test-Port 4416) { Add-Check '端口 4416' 'OK' 'POT HTTP 退路在跑' }
else { Add-Check '端口 4416' 'OK' '未占用（默认走 script 模式，正常）' }

try {
    $drive = (Get-PSDrive -Name $Root.Substring(0, 1) -ErrorAction Stop).Free
    $freeGB = [Math]::Round($drive / 1GB, 1)
    if ($freeGB -lt 2) { Add-Check '磁盘空间' 'WARN' "只剩 $freeGB GB，下载大文件可能不够" }
    else { Add-Check '磁盘空间' 'OK' "$freeGB GB 可用" }
}
catch { }

# ------------------------------------------------------------------ 输出
if ($Quiet) {
    $script:Rows = @($script:Rows | Where-Object { $_.状态 -ne 'OK' })
}

if (-not $Quiet) {
    Write-Host ''
    Write-Host '===============================================' -ForegroundColor DarkCyan
    Write-Host '  YouTube 下载器 —— 依赖体检' -ForegroundColor White
    Write-Host '===============================================' -ForegroundColor DarkCyan
    Write-Host "  程序目录：$Root" -ForegroundColor DarkGray
    Write-Host ''
}

foreach ($r in $script:Rows) {
    $c = Get-Color $r.状态
    Write-Host ("  [{0,-4}] {1} {2}" -f $r.状态, (Pad-Display $r.检查项 12), $r.详情) -ForegroundColor $c
}

$fail = @($script:Rows | Where-Object { $_.状态 -eq 'FAIL' }).Count
if ($fail -eq 0 -and -not $Quiet) {
    Write-Host ''
    Write-Host '  全部通过，可以启动。' -ForegroundColor Green
}
if ($fail -gt 0) {
    Write-Host ''
    Write-Host ("  有 {0} 项 FAIL，见上方红字。可尝试：" -f $fail) -ForegroundColor Yellow
    Write-Host '    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-deps.ps1' -ForegroundColor DarkGray
}

exit $(if ($fail -gt 0) { 1 } else { 0 })
