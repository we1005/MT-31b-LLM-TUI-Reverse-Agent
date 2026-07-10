# objection — 命令帮助（离线物化）

> 本文件由 scripts/gen-tool-help.sh 从本机真实二进制离线生成，供 agent grep 查工具语法。

- 二进制：`/Users/admin/.local/bin/objection`
- 版本：`Checking for a newer version of objection...`
- 生成于：本机（版本随安装现场，不联网）

---

## objection --help

```


A newer version of objection is available!
You have v1.12.4 and v1.12.5 is ready for download.

Upgrade with: pip3 install objection --upgrade
For more information, please see: https://github.com/sensepost/objection/wiki/Updating

Usage: objection [OPTIONS] COMMAND [ARGS]...

       _   _         _   _
   ___| |_|_|___ ___| |_|_|___ ___
  | . | . | | -_|  _|  _| | . |   |
  |___|___| |___|___|_| |_|___|_|_|
        |___|(object)inject(ion)
  
       Runtime Mobile Exploration
          by: @leonjza from @sensepost

Options:
  -N, --network            Connect using a network connection instead of USB.
  -h, --host TEXT          [default: 127.0.0.1]
  -P, --port INTEGER       [default: 27042]
  -ah, --api-host TEXT     [default: 127.0.0.1]
  -ap, --api-port INTEGER  [default: 8888]
  -n, --name TEXT          Name or bundle identifier to attach to.
  -S, --serial TEXT        A device serial to connect to.
  -d, --debug              Enable debug mode with verbose output.
  -s, --spawn              Spawn the target.
  -p, --no-pause           Resume the target immediately.
  -f, --foremost           Use the current foremost application.
  --debugger               Enable the Chrome debug port.
  --uid TEXT               Specify the uid to run as (Android only).
  --help                   Show this message and exit.

Commands:
  api       Start the objection API server in headless mode.
  patchapk  Patch an APK with the frida-gadget.so.
  patchipa  Patch an IPA with the FridaGadget dylib.
  run       Run a single objection command.
  signapk   Zipalign and sign an APK with the objection key.
  start     Start a new session
  version   Prints the current version and exits.

```
