# androguard — 命令帮助（离线物化）

> 本文件由 scripts/gen-tool-help.sh 从本机真实二进制离线生成，供 agent grep 查工具语法。

- 二进制：`/Users/admin/.local/bin/androguard`
- 版本：`androguard, version 4.1.3`
- 生成于：本机（版本随安装现场，不联网）

---

## androguard --help

```
Usage: androguard [OPTIONS] COMMAND [ARGS]...

  Androguard is a full Python tool to reverse Android Applications.

Options:
  --version           Show the version and exit.
  --verbose, --debug  Print more
  --help              Show this message and exit.

Commands:
  analyze      Open a IPython Shell and start reverse engineering.
  apkid        Prints the packageName/versionCode/versionName per APK as...
  arsc         Decode resources.arsc either directly from a given file or...
  axml         Parse the AndroidManifest.xml.
  cg           Create a call graph based on the data of Analysis and...
  decompile    Decompile an APK and create Control Flow Graphs.
  disassemble  Disassemble Dalvik Code with size SIZE starting from an...
  dtrace       Start dynamically an installed APK on the phone and start...
  dump         Start and dump dynamically an installed APK on the phone
  sign         Return the fingerprint(s) of all certificates inside an APK.
  trace        Push an APK on the phone and start to trace all...

```
