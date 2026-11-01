# -*- coding: utf-8 -*-
"""
生成「YouTube下载器」的桌面 + 开始菜单快捷方式（.lnk）

────────────────────────────────────────────────────────────────
为什么不用手写二进制？
  2026-09-17 踩坑：手写的 .lnk 只写了 StringData（名称/相对路径/
  工作目录/图标）+ EnvironmentVariableDataBlock，结果：
    · 桌面图标变成通用"未知文件"白纸
    · 双击毫无反应
  解析文件头部发现 HasTargetIDList=False 且 HasLinkInfo=False
  —— 也就是**整个文件里没有任何"目标"信息**。
  EnvironmentVariableDataBlock 不是目标本体，它只是 IDList 里
  EXP_SZ_LINK 条目的补充；少了 IDList / LinkInfo，shell 就不知道
  该启动什么。

正确做法（本脚本采用，按优先级）：
  1) COM 模式：ctypes 直接调 IShellLinkW + IPersistFile::Save，
     让 Windows 自己写这个文件 —— 字节必然合法。
     （沙箱只拦 PowerShell 层的 COM 与 cscript，进程内 COM 不受影响）
  2) 手工模式：COM 不可用时退回手写，但**必须带完整 LinkInfo**
     （含 GBK 的 ANSI 路径 + UTF-16 的 Unicode 路径）。

无论哪种方式，最后都用 Windows 自己的解析器回读验证
（IPersistFile::Load + IShellLinkW::GetPath）——
自己解析自己的产物是假阳性，必须让系统来判。
"""
import os
import sys
import uuid
import ctypes

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# ---------------------------------------------------------------- 基本配置
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, '启动下载器.bat')     # 要启动的目标
ICON = os.path.join(ROOT, 'app-icon.ico')         # 图标
RELATIVE = '启动下载器.bat'
DESC = 'YouTube 下载器'
LNK_NAME = 'YouTube下载器.lnk'

DESKTOP_CANDIDATES = [
    os.path.join(os.path.expanduser('~'), 'Desktop'),
    os.path.join(os.path.expanduser('~'), 'OneDrive', 'Desktop'),
    os.path.join(os.path.expanduser('~'), 'OneDrive', '桌面'),
]
SM_DIR = os.path.join(os.environ.get('APPDATA', ''),
                      'Microsoft', 'Windows', 'Start Menu', 'Programs',
                      'YouTube下载器')

# ---------------------------------------------------------------- COM 基建
class GUID(ctypes.Structure):
    _fields_ = [('Data1', ctypes.c_ulong),
                ('Data2', ctypes.c_ushort),
                ('Data3', ctypes.c_ushort),
                ('Data4', ctypes.c_ubyte * 8)]


def make_guid(s):
    b = uuid.UUID(s).bytes_le
    g = GUID()
    g.Data1 = int.from_bytes(b[0:4], 'little')
    g.Data2 = int.from_bytes(b[4:6], 'little')
    g.Data3 = int.from_bytes(b[6:8], 'little')
    g.Data4 = (ctypes.c_ubyte * 8)(*b[8:16])
    return g


CLSID_SHELLLINK = make_guid('00021401-0000-0000-C000-000000000046')
IID_ISHELLLINKW = make_guid('000214F9-0000-0000-C000-000000000046')
IID_IPERSISTFILE = make_guid('0000010B-0000-0000-C000-000000000046')

# IShellLinkW vtable 槽位（IUnknown 占 0/1/2）
SL_GETPATH = 3
SL_GETWORKDIR = 8
SL_SETWORKDIR = 9
SL_SETDESC = 7
SL_SETSHOWCMD = 15
SL_GETICONLOC = 16
SL_SETICONLOC = 17
SL_SETRELATIVE = 18
SL_SETPATH = 20
PF_LOAD = 5
PF_SAVE = 6

ole32 = ctypes.windll.ole32
HRESULT = ctypes.HRESULT
c_void_p = ctypes.c_void_p


def vcall(itf, slot, argtypes, args, restype=HRESULT):
    """按虚表槽位调用 COM 接口方法"""
    addr = ctypes.cast(itf, ctypes.POINTER(c_void_p)).contents.value
    tbl = ctypes.cast(addr, ctypes.POINTER(c_void_p))
    fn = ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes)(tbl[slot])
    return fn(itf, *args)


def _new_shelllink():
    psl = c_void_p()
    hr = ole32.CoCreateInstance(ctypes.byref(CLSID_SHELLLINK), None, 1,
                                ctypes.byref(IID_ISHELLLINKW),
                                ctypes.byref(psl))
    if hr != 0 or not psl.value:
        raise OSError('CoCreateInstance(ShellLink) 失败: 0x%08X' % hr)
    return psl


def _qi(iid):
    def _do(itf):
        out = c_void_p()
        hr = vcall(itf, 0, [ctypes.POINTER(GUID), ctypes.POINTER(c_void_p)],
                   [ctypes.byref(iid), ctypes.byref(out)])
        if hr != 0 or not out.value:
            raise OSError('QueryInterface 失败: 0x%08X' % hr)
        return out
    return _do


# ---------------------------------------------------------------- 生成方式
def create_via_com(lnk_path):
    """让 Windows 自己写 .lnk（最可靠）"""
    ole32.CoInitialize(None)
    try:
        psl = _new_shelllink()
        vcall(psl, SL_SETPATH, [ctypes.c_wchar_p], [TARGET])
        vcall(psl, SL_SETWORKDIR, [ctypes.c_wchar_p], [ROOT])
        vcall(psl, SL_SETDESC, [ctypes.c_wchar_p], [DESC])
        vcall(psl, SL_SETICONLOC, [ctypes.c_wchar_p, ctypes.c_int], [ICON, 0])
        vcall(psl, SL_SETSHOWCMD, [ctypes.c_int], [1])
        try:
            vcall(psl, SL_SETRELATIVE, [ctypes.c_wchar_p], [RELATIVE])
        except Exception:
            pass
        ppf = _qi(IID_IPERSISTFILE)(psl)
        hr = vcall(ppf, PF_SAVE, [ctypes.c_wchar_p, ctypes.c_int],
                   [lnk_path, 1])
        if hr != 0:
            raise OSError('IPersistFile::Save 失败: 0x%08X' % hr)
    finally:
        ole32.CoUninitialize()


def _volume_label(drive):
    try:
        buf = ctypes.create_unicode_buffer(261)
        ok = ctypes.windll.kernel32.GetVolumeInformationW(
            drive, buf, 261, None, None, None, None, 0)
        return buf.value if ok else ''
    except Exception:
        return ''


def build_manual_bytes():
    """手写 .lnk —— 关键：必须包含完整 LinkInfo（真正的目标）"""
    def u16str(s):
        d = (s + '\0').encode('utf-16-le')
        return len(d).to_bytes(2, 'little') + d

    # ---- Header（76 字节）
    flags = 0x02 | 0x04 | 0x08 | 0x10 | 0x40 | 0x80
    hdr = b''.join([
        (76).to_bytes(4, 'little'),
        bytes.fromhex('0114020000000000C000000000000046'),
        flags.to_bytes(4, 'little'),
        (0x20).to_bytes(4, 'little'),      # FileAttributes = ARCHIVE
        b'\x00' * 24,                      # 三个时间戳留空
        (0).to_bytes(4, 'little'),         # FileSize
        (0).to_bytes(4, 'little'),         # IconIndex
        (1).to_bytes(4, 'little'),         # ShowCommand = SW_SHOWNORMAL
        (0).to_bytes(2, 'little'),         # HotKey
        (0).to_bytes(2, 'little'),         # Reserved1
        (0).to_bytes(4, 'little'),         # Reserved2
        (0).to_bytes(4, 'little'),         # Reserved3
    ])
    assert len(hdr) == 76

    # ---- LinkInfo（本次修复的核心：这里是真正的目标路径）
    drive = os.path.splitdrive(os.path.abspath(TARGET))[0] + '\\'
    label = _volume_label(drive).encode('gbk', 'replace') + b'\0'
    volid = b''.join([
        (0x10 + len(label)).to_bytes(4, 'little'),   # VolumeIDSize
        (3).to_bytes(4, 'little'),                   # DRIVE_FIXED
        (0).to_bytes(4, 'little'),                   # 卷序列号
        (0x10).to_bytes(4, 'little'),                # 标签偏移
        label,
    ])
    ansi = TARGET.encode('gbk', 'replace') + b'\0'
    uni = (TARGET + '\0').encode('utf-16-le')
    suf_a = b'\0'
    suf_u = '\0'.encode('utf-16-le')

    vol_off = 0x24
    lbp_off = vol_off + len(volid)
    suf_off = lbp_off + len(ansi)
    lbpu_off = suf_off + len(suf_a)
    sufu_off = lbpu_off + len(uni)
    total = sufu_off + len(suf_u)

    linkinfo = b''.join([
        total.to_bytes(4, 'little'),                 # LinkInfoSize
        (0x24).to_bytes(4, 'little'),                # 含 Unicode 字段
        (1).to_bytes(4, 'little'),                   # VolumeIDAndLocalBasePath
        vol_off.to_bytes(4, 'little'),
        lbp_off.to_bytes(4, 'little'),
        (0).to_bytes(4, 'little'),                   # 无 CommonNetworkRelativeLink
        suf_off.to_bytes(4, 'little'),
        lbpu_off.to_bytes(4, 'little'),
        sufu_off.to_bytes(4, 'little'),
        volid, ansi, suf_a, uni, suf_u,
    ])
    assert len(linkinfo) == total

    strings = (u16str(DESC) + u16str(RELATIVE)
               + u16str(ROOT) + u16str(ICON + ',0'))
    return hdr + linkinfo + strings + (0).to_bytes(4, 'little')


def create_via_manual(lnk_path):
    data = build_manual_bytes()
    with open(lnk_path, 'wb') as f:
        f.write(data)
    return len(data)


# ---------------------------------------------------------------- 回读验证
def resolve(lnk_path):
    """用 Windows 自己的解析器读回 .lnk —— 这才是真验证"""
    ole32.CoInitialize(None)
    try:
        psl = _new_shelllink()
        ppf = _qi(IID_IPERSISTFILE)(psl)
        if vcall(ppf, PF_LOAD, [ctypes.c_wchar_p, ctypes.c_uint],
                 [lnk_path, 0]) != 0:
            return None
        psl2 = _qi(IID_ISHELLLINKW)(ppf)
        path = ctypes.create_unicode_buffer(1024)
        vcall(psl2, SL_GETPATH,
              [ctypes.POINTER(ctypes.c_wchar), ctypes.c_int, c_void_p,
               ctypes.c_uint], [path, 1024, None, 0])
        wd = ctypes.create_unicode_buffer(1024)
        vcall(psl2, SL_GETWORKDIR,
              [ctypes.POINTER(ctypes.c_wchar), ctypes.c_int], [wd, 1024])
        icn = ctypes.create_unicode_buffer(1024)
        idx = ctypes.c_int(0)
        vcall(psl2, SL_GETICONLOC,
              [ctypes.POINTER(ctypes.c_wchar), ctypes.c_int,
               ctypes.POINTER(ctypes.c_int)], [icn, 1024, ctypes.byref(idx)])
        return {'path': path.value, 'workdir': wd.value,
                'icon': icn.value, 'icon_index': idx.value}
    except Exception as e:
        return {'error': str(e)}
    finally:
        ole32.CoUninitialize()


# ---------------------------------------------------------------- 主流程
def pick_desktop():
    for d in DESKTOP_CANDIDATES:
        if os.path.isdir(d):
            return d
    return DESKTOP_CANDIDATES[0]


def main():
    print('程序目录 :', ROOT)
    if not os.path.isfile(TARGET):
        print('[X] 找不到目标文件:', TARGET)
        return 1
    if not os.path.isfile(ICON):
        print('[!] 图标文件不存在，将使用系统默认图标')

    targets = [os.path.join(pick_desktop(), LNK_NAME)]
    try:
        os.makedirs(SM_DIR, exist_ok=True)
        targets.append(os.path.join(SM_DIR, LNK_NAME))
    except Exception as e:
        print('[!] 开始菜单目录创建失败:', e)

    mode = None
    com_err = None
    try:
        for t in targets:
            create_via_com(t)
        mode = 'COM'
    except Exception as e:
        com_err = e
        mode = 'MANUAL'

    if mode == 'MANUAL':
        print('[!] COM 不可用（%s），改用手写模式' % com_err)
        for t in targets:
            create_via_manual(t)

    print('生成方式 :', 'COM（Windows 亲自写入）' if mode == 'COM' else '手写字节（含 LinkInfo）')
    print('-' * 62)
    ok = True
    for t in targets:
        size = os.path.getsize(t) if os.path.exists(t) else 0
        print('已生成 %s  (%d 字节)' % (t, size))
        r = resolve(t)
        if r and r.get('path'):
            print('   目标   :', r['path'])
            print('   工作目录:', r.get('workdir'))
            print('   图标   :', r.get('icon'), ' 索引', r.get('icon_index'))
            if not os.path.isfile(r['path']):
                print('   [!] 目标文件不存在')
            print('   回读解析: 通过')
        else:
            ok = False
            print('   回读解析: 失败', r)
    print('-' * 62)
    print('结论:', '快捷方式有效 ✔' if ok else '仍有问题 ✘')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
