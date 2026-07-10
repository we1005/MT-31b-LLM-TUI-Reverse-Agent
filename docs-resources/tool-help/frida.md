# frida — 命令帮助（离线物化）

> 本文件由 scripts/gen-tool-help.sh 从本机真实二进制离线生成，供 agent grep 查工具语法。

- 二进制：`/Users/admin/.local/bin/frida`
- 版本：`17.9.10`
- 生成于：本机（版本随安装现场，不联网）

---

## frida --help

```
usage: frida [options] target

positional arguments:
  args                  extra arguments and/or target

options:
  -h, --help            show this help message and exit
  -D, --device ID       connect to device with the given ID
  -U, --usb             connect to USB device
  -R, --remote          connect to remote frida-server
  -H, --host HOST       connect to remote frida-server on HOST
  --certificate CERTIFICATE
                        speak TLS with HOST, expecting CERTIFICATE
  --origin ORIGIN       connect to remote server with “Origin” header set to
                        ORIGIN
  --token TOKEN         authenticate with HOST using TOKEN
  --keepalive-interval INTERVAL
                        set keepalive interval in seconds, or 0 to disable
                        (defaults to -1 to auto-select based on transport)
  --device-option option
                        override a backend-specific option, such as “control-
                        endpoint=(string)localabstract:/my-frida-server”
                        (supported types are: string, bool, int)
  --p2p                 establish a peer-to-peer connection with target
  --stun-server ADDRESS
                        set STUN server ADDRESS to use with --p2p
  --relay address,username,password,turn-{udp,tcp,tls}
                        add relay to use with --p2p
  -f, --file TARGET     spawn FILE
  -F, --attach-frontmost
                        attach to frontmost application
  -n, --attach-name NAME
                        attach to NAME
  -N, --attach-identifier IDENTIFIER
                        attach to IDENTIFIER
  -p, --attach-pid PID  attach to PID
  -W, --await PATTERN   await spawn matching PATTERN
  --stdio {inherit,pipe}
                        stdio behavior when spawning (defaults to “inherit”)
  --aux option          set aux option when spawning, such as “uid=(int)42”
                        (supported types are: string, bool, int)
  --realm {native,emulated}
                        realm to attach in
  --runtime {qjs,v8}    script runtime to use
  --debug               enable the Node.js compatible script debugger
  --squelch-crash       if enabled, will not dump crash report to console
  -O, --options-file FILE
                        text file containing additional command line options
  --version             show program's version number and exit
  -l, --load SCRIPT     load SCRIPT
  -P, --parameters PARAMETERS_JSON
                        parameters as JSON, same as Gadget
  -C, --cmodule USER_CMODULE
                        load CMODULE
  --toolchain {any,internal,external}
                        CModule toolchain to use when compiling from source
                        code
  -c, --codeshare CODESHARE_URI
                        load CODESHARE_URI
  -e, --eval CODE       evaluate CODE
  -q                    quiet mode (no prompt) and quit after -l and -e
  -t, --timeout TIMEOUT
                        seconds to wait before terminating in quiet mode (or
                        'inf' to run forever)
  --pause               leave main thread paused after spawning program
  -o, --output LOGFILE  output to log file
  --eternalize          eternalize the script before exit
  --exit-on-error       exit with code 1 after encountering any exception in
                        the SCRIPT
  --kill-on-exit        kill the spawned program when Frida exits
  --auto-perform        wrap entered code with Java.perform
  --auto-reload         Enable auto reload of provided scripts and c module
                        (on by default, will be required in the future)
  --no-auto-reload      Disable auto reload of provided scripts and c module

```
