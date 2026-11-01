# bin/ —— 第三方可执行文件

这个目录**不在版本库里**（`.gitignore` 里排除了 `bin/*`），因为里面的文件是第三方二进制，
体积大、且各自有独立的许可证。

程序运行需要这里有两个文件：

| 文件 | 用途 | 体积参考 | 来源 |
|---|---|---|---|
| `ffmpeg.exe` | 合并音视频流、转 mp3、嵌入封面/元数据 | ~84 MB | https://www.gyan.dev/ffmpeg/builds/ （release-essentials 版） |
| `yt-dlp.exe` | 独立版下载器（**可选**，见下） | ~17 MB | https://github.com/yt-dlp/yt-dlp/releases |

## 关于 yt-dlp.exe：一般情况下不需要它

程序优先使用「随包 CPython + pip 版 yt-dlp」运行：

```
runtime\python\python.exe -m yt_dlp
```

只有这个不存在时，才回退到本目录的独立 exe。

**为什么优先 pip 版：** 独立 exe **不加载 yt_dlp_plugins**，因此拿不到 PO Token，
YouTube 会对多数视频返回 403 或只给 360p 合并流。pip 版才能加载
`bgutil-ytdlp-pot-provider` 插件。详见 [../docs/技术决策.md](../docs/技术决策.md)。

## 怎么补齐这两个文件

```powershell
# 在项目根目录执行，自动下载 ffmpeg 与 python 版 yt-dlp
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-deps.ps1
```

或者直接下载 [Release 便携包](https://github.com/Howjump/youtube-downloader/releases)，
解压即用，里面已经包含全部依赖。
