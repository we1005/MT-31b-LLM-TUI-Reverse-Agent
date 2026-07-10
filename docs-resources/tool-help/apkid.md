# apkid — 命令帮助（离线物化）

> 本文件由 scripts/gen-tool-help.sh 从本机真实二进制离线生成，供 agent grep 查工具语法。

- 二进制：`/Users/admin/.local/bin/apkid`
- 版本：`usage: apkid [-h] [-v] [-t TIMEOUT] [-r] [--scan-depth SCAN_DEPTH]`
- 生成于：本机（版本随安装现场，不联网）

---

## apkid --help

```
usage: apkid [-h] [-v] [-t TIMEOUT] [-r] [--scan-depth SCAN_DEPTH]
             [--entry-max-scan-size ENTRY_MAX_SCAN_SIZE] [--typing {magic,filename,none}] [-j]
             [-o DIR] [--include-types]
             [FILE ...]

APKiD - Android Application Identifier v3.1.0

positional arguments:
  FILE                                       apk, dex, or directory (default: None)

options:
  -h, --help                                 show this help message and exit
  -v, --verbose                              log debug messages (default: False)

scanning:
  -t, --timeout TIMEOUT                      Yara scan timeout (in seconds) (default: 30)
  -r, --recursive                            recurse into subdirectories (default: False)
  --scan-depth SCAN_DEPTH                    how deep to go when scanning nested zips (default: 2)
  --entry-max-scan-size ENTRY_MAX_SCAN_SIZE  max zip entry size to scan in bytes, 0 = no limit
                                             (default: 104857600)
  --typing {magic,filename,none}             method to decide which files to scan (default: magic)

output:
  -j, --json                                 output scan results in JSON format (default: False)
  -o, --output-dir DIR                       write individual results here (implies --json)
                                             (default: None)
  --include-types                            include file type info for matched files (default:
                                             False)

```
