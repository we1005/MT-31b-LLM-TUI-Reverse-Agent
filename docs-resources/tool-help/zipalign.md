# zipalign — 命令帮助（离线物化）

> 本文件由 scripts/gen-tool-help.sh 从本机真实二进制离线生成，供 agent grep 查工具语法。

- 二进制：`/opt/homebrew/share/android-commandlinetools/build-tools/36.0.0/zipalign`
- 版本：`zipalign: illegal option -- -`
- 生成于：本机（版本随安装现场，不联网）

---

## zipalign --help

```
zipalign: illegal option -- -
ERROR: unknown flag -?
Zip alignment utility
Copyright (C) 2009 The Android Open Source Project

Usage: zipalign [-f] [-p] [-P <pagesize_kb>] [-v] [-z] <align> infile.zip outfile.zip
       zipalign -c [-p] [-P <pagesize_kb>] [-v] <align> infile.zip

  <align>: alignment in bytes, e.g. '4' provides 32-bit alignment
  -c: check alignment only (does not modify file)
  -f: overwrite existing outfile.zip
  -p: 4kb page-align uncompressed .so files
  -v: verbose output
  -z: recompress using Zopfli
  -P <pagesize_kb>: Align uncompressed .so files to the specified
                    page size. Valid values for <pagesize_kb> are 4, 16
                    and 64. '-P' cannot be used in combination with '-p'.

```
