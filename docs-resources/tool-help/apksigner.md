# apksigner — 命令帮助（离线物化）

> 本文件由 scripts/gen-tool-help.sh 从本机真实二进制离线生成，供 agent grep 查工具语法。

- 二进制：`/opt/homebrew/share/android-commandlinetools/build-tools/36.0.0/apksigner`
- 版本：`0.9`
- 生成于：本机（版本随安装现场，不联网）

---

## apksigner --help

```
USAGE: apksigner <command> [options]
       apksigner --version
       apksigner --help

EXAMPLE:
       apksigner sign --ks release.jks app.apk
       apksigner verify --verbose app.apk

apksigner is a tool for signing Android APK files and for checking whether
signatures of APK files will verify on Android devices.


        COMMANDS
rotate                Add a new signing certificate to the SigningCertificateLineage

sign                  Sign the provided APK

verify                Check whether the provided APK is expected to verify on
                      Android

lineage               Modify the capabilities of one or more signers in an existing
                      SigningCertificateLineage

version               Show this tool's version number and exit

help                  Show this usage page and exit


```
