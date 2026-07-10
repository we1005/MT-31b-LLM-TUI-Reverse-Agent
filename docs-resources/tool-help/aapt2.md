# aapt2 — 命令帮助（离线物化）

> 本文件由 scripts/gen-tool-help.sh 从本机真实二进制离线生成，供 agent grep 查工具语法。

- 二进制：`/opt/homebrew/share/android-commandlinetools/build-tools/36.0.0/aapt2`
- 版本：`unknown option '--version'.`
- 生成于：本机（版本随安装现场，不联网）

---

## aapt2 --help

```
aapt2 [subcommand] [options] files...

Subcommands:
 compile                                           Compiles resources to be linked into an apk.
 link                                              Links resources into an apk.
 dump                                              
 diff                                              Prints the differences in resources of two apks.
 optimize                                          Preforms resource optimizations on an apk.
 convert                                           Converts an apk between binary and proto formats.
 version                                           Prints the version of aapt.
 apkinfo                                           Dump information about an APK in binary proto format.
 daemon                                            Runs aapt in daemon mode. Each subsequent line is a single parameter to the
                                                   command. The end of an invocation is signaled by providing an empty line.

Options:
 --help                                            Displays this help menu

```

## aapt2 dump --help

```
aapt2 dump [subcommand] [options] files...

Subcommands:
 apc                                               Print the contents of the AAPT2 Container (APC) generated fom compilation.
 badging                                           Print information extracted from the manifest of the APK.
 configurations                                    Print every configuration used by a resource in the APK.
 packagename                                       Print the package name of the APK.
 permissions                                       Print the permissions extracted from the manifest of the APK.
 strings                                           Print the contents of the resource table string pool in the APK.
 styleparents                                      Print the parents of a style in an APK.
 resources                                         Print the contents of the resource table from the APK.
 chunks                                            Print the chunk information of the compiled resources.arsc in the APK.
 xmlstrings                                        Print the string pool of a compiled xml in an APK.
 xmltree                                           Print the tree of a compiled xml in an APK.
 overlayable                                       Print the <overlayable> resources of an APK.

Options:
 --help                                            Displays this help menu

```

## aapt2 dump xmltree --help

```
dump xmltree [options] --file arg files...

Options:
 --help                                            Displays this help menu
 --file arg                                        A compiled xml file to print

```

## aapt2 dump badging --help

```
dump badging [options] files...

Options:
 --help                                            Displays this help menu
 --include-meta-data                               Include meta-data information.

```

## aapt2 dump permissions --help

```
dump permissions [options] files...

Options:
 --help                                            Displays this help menu

```

## aapt2 dump resources --help

```
dump resources [options] files...

Options:
 --help                                            Displays this help menu
 --no-values                                       Suppresses output of values when displaying resource tables.
 -v                                                Enables verbose logging.

```
