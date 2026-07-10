# apktool — 命令帮助（离线物化）

> 本文件由 scripts/gen-tool-help.sh 从本机真实二进制离线生成，供 agent grep 查工具语法。

- 二进制：`/opt/homebrew/bin/apktool`
- 版本：`3.0.2`
- 生成于：本机（版本随安装现场，不联网）

---

## apktool --help

```
Apktool 3.0.2 - a tool for reengineering Android apk files
with smali 3.0.9-dev and baksmali 3.0.9-dev
Copyright 2010 Ryszard Wiśniewski <brut.alll@gmail.com>
Copyright 2010 Connor Tumbleson <connor.tumbleson@gmail.com>
Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)

General options:
 -q,--quiet     Suppress normal output.
 -v,--verbose   Increase output verbosity.

apktool d|decode [options] <apk-file>
 -a,--all-src                   Decode all sources in the apk (includes unknown dex files).
 -f,--force                     Force delete destination directory.
    --ignore-raw-values         Ignore raw attribute values in XML resource files.
 -j,--jobs <num>                Set the number of jobs to execute in parallel to <num>.
    --keep-broken-res           Use if there was an error and some resources were dropped, e.g.
                                "Invalid resource config detected. Dropping resources", but you
                                want to decode them anyway, even with errors. You will have to
                                fix them manually before building.
 -l,--lib <package:file>        Use shared library <package> located in <file>.
                                Can be specified multiple times.
    --match-original            Keep files closest to original as possible (prevents rebuild).
    --no-assets                 Do not decode assets.
    --no-debug-info             Do not include debug info in sources (.local, .param, .line, etc.)
 -o,--output <dir>              Output decoded files to <dir>. (default: apk.out)
    --only-manifest             Only decode AndroidManifest.xml without resources.
 -p,--frame-path <dir>          Use framework files located in <dir>.
 -r,--no-res                    Do not decode resources.
    --res-resolve-mode <mode>   Set the resolve mode for resources to <mode>.
                                Possible values: 'default', 'greedy' or 'lazy'.
 -s,--no-src                    Do not decode sources.
 -t,--frame-tag <tag>           Use framework files tagged with <tag>.

apktool b|build [options] <apk-dir>
    --aapt <file>          Use aapt2 binary located in <file>.
    --copy-original        Copy original AndroidManifest.xml and META-INF. See project page for more info.
    --debuggable           Set android:debuggable to "true" in AndroidManifest.xml for the built apk.
 -f,--force                Skip changes detection and build all files.
 -j,--jobs <num>           Set the number of jobs to execute in parallel to <num>.
 -l,--lib <package:file>   Use shared library <package> located in <file>.
                           Can be specified multiple times.
    --net-sec-conf         Add a generic network security configuration file to the built apk.
    --no-apk               Disable repacking of the built files into a new apk.
    --no-crunch            Disable crunching of resource files during the build step.
 -o,--output <file>        Output the built apk to <file>. (default: dist/name.apk)
 -p,--frame-path <dir>     Use framework files located in <dir>.

apktool if|install-framework [options] <apk-file>
 -p,--frame-path <dir>   Set the path for framework files to <dir>.
 -t,--frame-tag <tag>    Suffix framework files with <tag>.

apktool cf|clean-frameworks [options]
 -a,--all                Include all framework files regardless of tag.
 -p,--frame-path <dir>   Set the path for framework files to <dir>.
 -t,--frame-tag <tag>    Suffix framework files with <tag>.

apktool lf|list-frameworks [options]
 -a,--all                Include all framework files regardless of tag.
 -p,--frame-path <dir>   Set the path for framework files to <dir>.
 -t,--frame-tag <tag>    Suffix framework files with <tag>.

apktool pr|publicize-resources <arsc-file>

apktool h|help

apktool v|version

For additional info, see: https://apktool.org
For smali/baksmali info, see: https://github.com/google/smali

```

## apktool d --help

```
Unrecognized option: --help
Apktool 3.0.2 - a tool for reengineering Android apk files
with smali 3.0.9-dev and baksmali 3.0.9-dev
Copyright 2010 Ryszard Wiśniewski <brut.alll@gmail.com>
Copyright 2010 Connor Tumbleson <connor.tumbleson@gmail.com>
Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)

General options:
 -q,--quiet     Suppress normal output.
 -v,--verbose   Increase output verbosity.

apktool d|decode [options] <apk-file>
 -a,--all-src                   Decode all sources in the apk (includes unknown dex files).
 -f,--force                     Force delete destination directory.
    --ignore-raw-values         Ignore raw attribute values in XML resource files.
 -j,--jobs <num>                Set the number of jobs to execute in parallel to <num>.
    --keep-broken-res           Use if there was an error and some resources were dropped, e.g.
                                "Invalid resource config detected. Dropping resources", but you
                                want to decode them anyway, even with errors. You will have to
                                fix them manually before building.
 -l,--lib <package:file>        Use shared library <package> located in <file>.
                                Can be specified multiple times.
    --match-original            Keep files closest to original as possible (prevents rebuild).
    --no-assets                 Do not decode assets.
    --no-debug-info             Do not include debug info in sources (.local, .param, .line, etc.)
 -o,--output <dir>              Output decoded files to <dir>. (default: apk.out)
    --only-manifest             Only decode AndroidManifest.xml without resources.
 -p,--frame-path <dir>          Use framework files located in <dir>.
 -r,--no-res                    Do not decode resources.
    --res-resolve-mode <mode>   Set the resolve mode for resources to <mode>.
                                Possible values: 'default', 'greedy' or 'lazy'.
 -s,--no-src                    Do not decode sources.
 -t,--frame-tag <tag>           Use framework files tagged with <tag>.

For additional info, see: https://apktool.org
For smali/baksmali info, see: https://github.com/google/smali

```

## apktool b --help

```
Unrecognized option: --help
Apktool 3.0.2 - a tool for reengineering Android apk files
with smali 3.0.9-dev and baksmali 3.0.9-dev
Copyright 2010 Ryszard Wiśniewski <brut.alll@gmail.com>
Copyright 2010 Connor Tumbleson <connor.tumbleson@gmail.com>
Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)

General options:
 -q,--quiet     Suppress normal output.
 -v,--verbose   Increase output verbosity.

apktool b|build [options] <apk-dir>
    --aapt <file>          Use aapt2 binary located in <file>.
    --copy-original        Copy original AndroidManifest.xml and META-INF. See project page for more info.
    --debuggable           Set android:debuggable to "true" in AndroidManifest.xml for the built apk.
 -f,--force                Skip changes detection and build all files.
 -j,--jobs <num>           Set the number of jobs to execute in parallel to <num>.
 -l,--lib <package:file>   Use shared library <package> located in <file>.
                           Can be specified multiple times.
    --net-sec-conf         Add a generic network security configuration file to the built apk.
    --no-apk               Disable repacking of the built files into a new apk.
    --no-crunch            Disable crunching of resource files during the build step.
 -o,--output <file>        Output the built apk to <file>. (default: dist/name.apk)
 -p,--frame-path <dir>     Use framework files located in <dir>.

For additional info, see: https://apktool.org
For smali/baksmali info, see: https://github.com/google/smali

```
