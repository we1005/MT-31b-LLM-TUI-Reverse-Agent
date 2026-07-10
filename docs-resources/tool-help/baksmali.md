# baksmali — 命令帮助（离线物化）

> 本文件由 scripts/gen-tool-help.sh 从本机真实二进制离线生成，供 agent grep 查工具语法。

- 二进制：`/Users/admin/.local/bin/baksmali`
- 版本：`baksmali 3.0.9-dev (http://smali.org)`
- 生成于：本机（版本随安装现场，不联网）

---

## baksmali --help

```
usage: baksmali [--help] [--version] [<command [<args>]]

Options:
  --help,-h,-? - Show usage information
  --version,-v - Print the version of baksmali and then exit

Commands:
  deodex(de,x) - Deodexes an odex/oat file
  disassemble(dis,d) - Disassembles a dex file.
  dump(du) - Prints an annotated hex dump for the given dex file
  help(h) - Shows usage information
  list(l) - Lists various objects in a dex file.

See baksmali help <command> for more information about a specific command

```
