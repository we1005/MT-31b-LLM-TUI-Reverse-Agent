# 08 · 动态分析与 Hook:Frida、Xposed/LSPosed、ART hook 内核、LSPatch

> **一句话点题**：安卓的"运行时改行为"(Hook)本质上跟你在 Linux 下用 `LD_PRELOAD` 换掉 `malloc`、或者用 Detours 改一个 Windows DLL 导出函数没有本质区别——只是安卓多了一层 Java 虚拟机(ART),所以"改的对象"从"一段机器码的入口地址"变成了"一个 `ArtMethod` 结构体里的函数指针";本篇就是把这层"结构体里的函数指针"到底长什么样、谁在改它、改的时候要不要 root、要不要碰 APK 文件,讲到你能在报告里一眼认出 `PmsHookApplication`、`lsplant`、`LSPatch 五件套`分别是这条链路上的哪一环。

读完 [05-APK签名体系](05-APK签名体系-v1v2v3v4.md) 和 [06-签名校验与防篡改](06-签名校验与防篡改.md),你已经知道"签名校验"是一次 Java 方法调用(`PackageManager.getPackageInfo(..., GET_SIGNATURES)`)返回的结果。本篇要讲的是：**除了在 APK 文件里"提前改好"(静态 patch,见 [11-签名校验绕过全景](11-签名校验绕过全景.md)),还能不能在 App 跑起来的那一刻,凭空让这个方法调用返回假结果?** 答案是能,这就是"运行时 Hook"——本篇的主题。

---

## 一、Hook 到底是什么：你已经会了,只是名字不同

如果你写过 C/C++,你一定见过(或亲手做过)下面几件事,它们和安卓 Hook 是**同一个套路**:

| 你熟悉的技术 | 改的是什么 | 什么时候生效 |
|---|---|---|
| `LD_PRELOAD=evil.so ./app` | ELF 动态链接时,先加载你的 `.so`,你的同名符号(如 `malloc`)会**优先于**libc 里的被链接器解析进 GOT | 进程启动、动态链接阶段 |
| 改 PLT/GOT 表项 | 进程已经跑起来后,直接把 GOT(全局偏移表)里某个函数的地址,改写成你自己函数的地址 | 运行时,任意时刻 |
| Windows Detours / inline hook | 把目标函数开头几字节机器码,改成一条 `jmp 你的函数`(叫 **trampoline**,"蹦床"——先跳到你这、你干完活再"弹"回原函数或跳过去) | 运行时,注入之后 |
| `dlopen` + `dlsym` 替换函数指针 | 某个模块里保存函数指针的变量,被你用 `dlopen` 拿到句柄后改写 | 运行时 |

**Hook 的通用定义**：在不改变"调用方怎么调用"的前提下,**把"被调用的那段代码"偷梁换柱**,让调用方以为自己在调用原函数,实际上执行的是你安插的代码(你可以在里面做任何事：记录参数、篡改返回值、完全短路原逻辑)。

```
正常调用:
  caller ──call──> [原函数机器码] ──return──> caller

Hook 之后:
  caller ──call──> [被改写的入口/跳板] ──jmp──> [你的 hook 函数]
                                                   │
                                    (可选)jmp 回──> [原函数机器码的备份]
```

安卓的特殊之处只有一点：**大部分你想 Hook 的目标(比如 `PackageManager.getPackageInfo`)是一段 DEX 字节码,跑在 ART 虚拟机里,不是一段可以直接改地址的机器码**。所以 Hook 一个 Java 方法,改的不是"内存里的机器码",而是 ART 虚拟机内部一个叫 `ArtMethod` 的**元数据结构体**里的字段——这是本篇第四节的重点,也是"ART hook"和"inline hook"的分水岭。

---

## 二、为什么这是"运行时绕签名"的底座

回顾 [06](06-签名校验与防篡改.md):App 判断"我有没有被篡改"的逻辑,归根结底是调用一个系统方法拿到签名信息再做比较。如果能在**方法被调用的那一刻**把返回值换成"正版签名",那么：

- 不用碰 APK 文件的字节(静态 patch 需要拆包、改 smali、重新打包签名——见 [11](11-签名校验绕过全景.md) 的"静态 patch"部分);
- 校验逻辑本身**一行没改**,只是它问系统"我的签名是什么"的时候,系统(被 Hook 后)撒了谎。

报告里 NP 管理器的 `android.n.PmsHookApplication`,干的正是这件事：**Hook 掉 `IPackageManager`(系统包管理服务的 Java 接口),让所有查询签名的调用都返回伪造结果**,而且它是"借用 `top.canyie.pine`"这个 ART hook 引擎实现的(第五节会细讲 pine)。这就是本篇要打的地基——**没有"运行时 Hook"这个技术底座,"一键去签名校验"里除了静态 patch 之外的所有花活都无从谈起**。

---

## 三、Zygote：所有 App 的"母进程"

在讲 Frida/Xposed 之前,必须先讲一个安卓独有的角色——**zygote**(受精卵的意思,取名很形象)。

**C++/Linux 类比**：你写过高并发服务器,大概率用过 **prefork 模型**(Nginx、老式 Apache 的做法)——主进程先把解释器/库都加载好、初始化完毕,然后 `fork()` 出一堆子进程去处理请求。子进程通过写时复制(Copy-on-Write)**共享**父进程已经加载好的内存页,省去重复初始化的开销。

安卓的 **zygote** 就是这个模式的极致应用：

- 系统开机时,先启动一个叫 `zygote` 的进程,它把 **ART 虚拟机本身、Java 核心类库(`android.jar` 里那一大堆基础类)全部预加载并初始化好**;
- 你每次点开一个 App 图标,系统不是"从头启动一个新程序",而是让 `zygote` **`fork()`** 出一个新进程,这个新进程天生就带着 ART 虚拟机和所有基础类库的现成内存(通过 CoW 共享,几乎零成本);
- fork 出来之后,新进程才去加载这个 App 自己的 DEX、执行 `Application.onCreate()`(参见 [03](03-ART运行时-类加载与反射与JNI.md))。

```
                    ┌─────────────┐
                    │   zygote    │  ← ART 虚拟机 + 基础类库,预热好放在这
                    │ (母进程)     │
                    └──────┬──────┘
                fork()  fork()  fork()
              ┌───────┐ ┌───────┐ ┌───────┐
              │ App A │ │ App B │ │ App C │  ← 每个 App 都是 zygote 的孩子
              └───────┘ └───────┘ └───────┘
```

**这对 Hook 意味着什么**：如果你能在 zygote **fork 出子进程的那一瞬间**,往子进程里注入一段自己的代码,那么**系统里所有的 App(包括之后才安装、之后才启动的)都会自动带上你的注入代码**——这比一个个 App 单独下手效率高得多。第五节讲的 Riru/Zygisk,做的就是"如何安全地在 zygote 这个环节插一脚"。

---

## 四、ART 方法 Hook 内核：改的到底是哪个字段

这是本篇最"硬核"也最值得你花时间理解的部分,因为它直接对应你熟悉的"改函数指针"直觉。

### 4.1 ArtMethod：每个 Java 方法在内存里的"身份证"

ART 虚拟机里,**每一个 Java/Kotlin 方法**(不管是不是 native 方法)在运行时都对应内存里的一个 C++ 结构体,叫 **`ArtMethod`**。你可以把它类比成：

> 在 C++ 里,一个虚函数会在 vtable 里占一个"函数指针槽位";`ArtMethod` 就是安卓给**每一个** Java 方法(不只是虚函数)都分配的、更丰富的一份"槽位+元数据"。

`ArtMethod`(简化后)大致包含：

```cpp
struct ArtMethod {
    uint32_t declaring_class_;       // 属于哪个类
    uint32_t access_flags_;          // 方法的"权限位":public/private/native/abstract...
    uint32_t dex_code_item_offset_;  // 在 DEX 里,这个方法的字节码在哪(见 02 篇的 code_item)
    ...
    void*    entry_point_from_jni_;              // 如果是 native 方法,JNI 入口在这
    void*    entry_point_from_quick_compiled_code_; // ★ 关键字段,见下文
};
```

其中 **`entry_point_from_quick_compiled_code_`** 就是本篇的核心——它是一个**函数指针**,指向"当你调用这个方法时,CPU 真正应该跳过去执行的机器码地址"。这个地址可能指向：

- ART 的 **解释器**(逐条执行 DEX 字节码,慢但总能跑,详见 [02](02-DEX字节码与Smali汇编.md));
- ART 的 **JIT/AOT 编译产物**(方法被编译成机器码之后,直接跳过去执行,快);
- 一个 **JNI trampoline**(如果这个方法被标记为 native,见下文)。

**类比一下**:`entry_point_from_quick_compiled_code_` 就相当于 C++ 里一个函数指针变量,或者 vtable 里的一个槽位。**改写这个指针,效果等价于改 GOT 表项、改 vtable 槽位**——调用方(caller)的代码完全没变,但它跳过去执行的地方变了。

### 4.2 经典套路：把方法标记成 native,再顶替入口

绝大多数 ART hook 引擎(Xposed 系、pine、SandHook、LSPlant……)的核心操作可以概括成两步：

**第一步：改 `access_flags_`,加上 `kAccNative` 标志位。**

这一步是在"骗虚拟机"：告诉 ART "这个方法其实是个 native 方法(JNI 方法)",尽管它原本是一段普通的 Java 字节码方法。为什么要骗?因为 ART 对"是不是 native 方法"的处理路径不同——一旦一个方法被认为是 native,它的调用完全经由 `entry_point_from_jni_`/`entry_point_from_quick_compiled_code_` 这类**可被外部注册**的函数指针分发,不再走"直接解释/执行 DEX 字节码"那条僵化路径。这跟 JNI 的 `RegisterNatives`(见 [03](03-ART运行时-类加载与反射与JNI.md))本来就是同一套机制——Hook 框架只是"借用"了 JNI 本该走的那条腿。

**第二步：把 `entry_point_from_quick_compiled_code_`(或对应字段)指向一个 trampoline(蹦床函数)。**

这个 trampoline 干的事情是：

1. 先调用 Hook 框架注册的"你的回调函数"(Java 或 Native 写的都行),把原始调用参数传给它;
2. 你的回调函数可以看参数、改参数、直接伪造返回值、或者调用"备份的原方法"(Hook 框架通常会在 Hook 前,把原方法的 `ArtMethod` 整个复制一份存起来,充当"backup method",这样你随时能"调用原逻辑");
3. 把最终结果返回给调用方——调用方全程不知道自己被"掉包"了。

```
Hook 前:
  caller 调用 method.entry_point ──> [DEX 字节码解释/JIT 机器码]

Hook 后:
  caller 调用 method.entry_point ──> [trampoline]
                                        │
                              ┌─────────┴─────────┐
                              ▼                     ▼
                        你的回调函数           (可选)backup_method
                        (改参数/伪造返回值)      (原始逻辑的备份副本)
```

这套"改 `access_flags_` + 顶替 entry point + 备份原方法"的手法,最早被 Xposed 用在 Dalvik 时代(改的是 Dalvik 的方法结构体),后来 ART 取代 Dalvik 后,各家引擎(YAHFA、pine、SandHook、LSPlant)都在"ART 内部结构体每个安卓版本都在变"这件事上各显神通——这也是为什么 ART hook 引擎特别"娇气"、经常随系统大版本升级而"暂时失效",需要作者跟进适配(这跟你写 x86/ARM 内核态驱动、跟每次内核大版本适配私有结构体偏移量是一回事)。

> 想深挖 `ArtMethod` 结构体每个字段在不同安卓版本里的确切偏移量,可以看 AOSP 源码 `art/runtime/art_method.h`,以及 LSPlant 项目的适配代码(第五节有链接)。

---

## 五、动态插桩：Frida——不改 APK,靠"外挂进程"

**Frida** 是一个跨平台的动态插桩(instrumentation)框架,支持 Windows/Linux/macOS/iOS/安卓/QNX,是逆向圈公认的"瑞士军刀"。它跟本篇前面讲的"ART 方法 Hook"不是竞争关系,而是**互补**——Frida 既能 Hook Java 方法(靠调用 ART 内部接口,原理和第四节一致),也能直接 Hook **native 层的 `.so` 里的任意函数**(不需要经过 ART,纯粹的 inline hook)。

### 5.1 两大组成：frida-core(注入)+ frida-gum(插桩引擎)

- **frida-gum**：真正做"改函数"这件脏活的引擎,内置 `Interceptor`(inline hook 包装器——把目标函数开头几字节换成跳转到你代码的 trampoline,和 Detours 是同一思路)、`Stalker`(动态代码追踪,可以逐条记录 CPU 实际执行的指令流,常用于脱壳/找隐藏调用)、内存扫描/符号查找等工具。
- **frida-server**：跑在手机上的一个**常驻服务进程**,监听端口(默认 27042),等你的电脑上的 `frida` 客户端连过来发指令。

### 5.2 注入方式：ptrace 劫持线程

Frida attach 到一个正在运行的进程时(最常见的用法),大致步骤是：

1. 用 **`ptrace`**(Linux 的进程跟踪系统调用,`gdb` 底层也是用它)**劫持目标进程的一个线程**——暂停它,把它的寄存器状态保存下来;
2. 在目标进程里申请一块内存,写入一段"迷你启动器"(bootstrap)机器码;
3. 让被劫持的线程去执行这段启动器,启动器会：开一个新线程、连接手机上跑着的 `frida-server`、把 `frida-agent.so`(真正的插桩逻辑)`dlopen` 进当前进程;
4. **注入完成后,Frida 立刻从 `ptrace` 脱离**(detach),被劫持线程恢复原状,继续正常跑——`ptrace` 只是"送快递"的手段,不是长期占用的调试状态。

之后,你写的 **JS 脚本**(Frida 的用户接口是 JavaScript,通过 V8/QuickJS 引擎跑在 Agent 里)就能调用 `Interceptor.attach()`、`Java.use()` 之类的 API,对目标进程为所欲为——包括第四节讲的"改 `ArtMethod` 的 entry point"这种活,Frida 都帮你封装好了。

### 5.3 Frida 的几种模式,决定"要不要碰 APK"

| 模式 | 要不要 root | 要不要改 APK | 要不要常驻进程 |
|---|---|---|---|
| **Attach 模式**(最常用) | 需要(才能跑 `frida-server`,或至少能起一个有调试权限的进程) | 不需要 | 需要,`frida-server` 常驻手机后台 |
| **Gadget 模式**(把 `frida-gadget.so` 塞进 APK 里自启动) | 不需要 root | **需要改 APK**(塞一个 so + 改 manifest/加载点) | 不需要额外常驻进程,gadget 随 App 自己启动 |
| **Spawn 模式** | 需要 | 不需要 | 需要 `frida-server`,但可以在 App 进程刚起来、代码还没执行时就挂上(适合分析"启动即自毁"的反调试逻辑) |

所以准确地说：**"Frida 不改 APK"这个说法只对 Attach 模式成立**——这也是报告里"运行时 hook 绕过 vs Frida"分类的依据(Frida 常被归为"验证/取证"手段,因为不需要像 LSPatch 那样把 Xposed 整个运行时嵌进包体)。

---

## 六、Xposed 谱系：Xposed → EdXposed → LSPosed

Frida 是"你手动写脚本、临时挂上去分析"的工具;而 **Xposed** 走的是另一条路——**做一个"插件商店"式的框架,让第三方模块常驻系统、对所有 App(或指定 App)的行为做永久性的、开机自启的修改**。

### 6.1 老祖宗 Xposed(2012 年,rovo89)

原始 Xposed 的做法很暴力：**替换系统里的 `app_process`(zygote 的启动程序)**,在虚拟机启动阶段的最早期就把自己的 hook 逻辑注入进去,让每个由 zygote fork 出来的 App 天生带着 Xposed 的能力。它需要 root,而且直接改系统分区文件,风险和侵入性都很高,只支持较老的 Android 版本(Dalvik 时代)。

### 6.2 EdXposed(ART 时代的续命)

Android 5.0 后 Dalvik 换成 ART,老 Xposed 的底层 hook 手法失效,社区做出 **EdXposed**,把 hook 引擎换成能适配 ART 的实现(早期基于 **YAHFA** 或后来的 **SandHook**,见第七节),并且**不再直接改系统分区**,而是依托 **Magisk**(一个 root 方案+"系统分区虚拟层"框架,专门做"不落地修改系统文件"的 root 与模块系统)之上的 **Riru**(见下一节)来注入 zygote。EdXposed 一度是主流,但**已经停止维护**,官方也建议迁移到下面这个继任者。

### 6.3 LSPosed(现在的主流)

**LSPosed** 是目前最活跃、生态最完整的 Xposed 实现,由 LSPosed 团队(和上面提过的 pine 作者 canyie 等有交集)维护,核心特点：

- Hook 引擎换成自研的 **LSPlant**(第七节细讲),适配新版本 Android 更快、更稳定;
- 依托 **Zygisk**(Riru 的继任者,见下节),不需要 Riru 这个中间层;
- 保持和原始 Xposed **API 兼容**,老模块基本能直接用;
- 需要 root + Magisk(或 KernelSU 等 root 方案的 Zygisk 实现)。

```
Xposed(2012,改 app_process,只支持 Dalvik)
   │  ART 上位,老手法失效
   ▼
EdXposed(依托 Riru 注入 zygote,引擎 YAHFA/SandHook) ── 已停止维护
   │  Riru 被 Zygisk 取代
   ▼
LSPosed(依托 Zygisk,引擎 LSPlant) ── 当前主流
```

---

## 七、Riru vs Zygisk：两代"扎进 zygote"的方案

第三节讲过,能在 **zygote fork 子进程的那一刻**插一脚,就能让"所有 App 自动被注入",这是效率最高的打法。**Riru** 和 **Zygisk** 就是先后两代"怎么安全地插这一脚"的工程方案。

- **Riru**(RikkaApps 出品)：作为一个 Magisk 模块,替换/劫持 zygote 进程里的关键函数,给"Riru 模块"(比如 EdXposed)提供在 App 进程 fork 出来的早期阶段执行代码的钩子(hook point)。它本身**不做具体的 hook 逻辑**,只负责"帮别人把代码送进 zygote 子进程"这一步基础设施。**已被官方标注为废弃(deprecated)**,不再推荐新模块基于它开发。
- **Zygisk**:Magisk v24 开始**内置**的替代方案,直接把"注入 zygote"这件事做进 Magisk 核心,不再需要单独安装 Riru 这一层。相比 Riru,Zygisk 集成度更高(免去额外安装步骤)、对新版 Android 的兼容和安全性(比如更好地应对 Play Integrity 一类的完整性检测)也做了针对性加固。LSPosed 现在就是跑在 Zygisk 之上。

**一句话理解两者关系**:Riru/Zygisk 解决的是"如何进场"(怎么把代码送进每一个即将诞生的 App 进程),LSPlant/YAHFA/pine/SandHook 解决的是"进场之后怎么改函数"(第四节讲的 `ArtMethod` 操作)——**两层技术分工不同,前者是"运输",后者是"手术"**。

---

## 八、hook 引擎大盘点：LSPlant / YAHFA / pine / SandHook / Epic / Dobby

这几个名字在报告和各种破解教程里高频出现,本质上都是"实现第四节那套 `ArtMethod` 操作"的具体代码库,只是各自的设计取舍、性能、兼容性不同：

| 引擎 | 作者/归属 | 核心思路 | 特点 |
|---|---|---|---|
| **YAHFA**(Yet Another Hook Framework for ART) | PAGalaxyLab | 需要你**手动提供**"hook 方法"和"备份方法"(参数需与目标方法匹配),直接改 `ArtMethod` entry point | 历史最久、被认为最稳定,兼容性打磨时间最长,早期 EdXposed 用过 |
| **pine** | canyie(NP 管理器用的就是它,见报告 `PmsHookApplication`) | 提供类 Xposed 的接口(你只需给回调,不用手写 backup 方法),支持 entry point 替换和 inline hook 两种手段 | 名字取自 "Pine Is Not Epic"(致敬/区别于 Epic);作者称是在 Epic 闭源后"没有满足需求的开源方案"才自己写的 |
| **SandHook** | Rprop(ele7enxxh 团队) | 以 **inline hook**(直接改机器码)为主、entry point 替换为兜底方案 | 兼容性号称优于同期方案,但对 ARM64 支持更完善,x86/x86_64 支持较弱 |
| **Epic** | Tencent(原多面手团队),已闭源/停止开源维护 | 早期 ART hook 名作,启发了后续包括 pine 在内的很多设计 | 现状是**闭源**,社区已转向 pine/SandHook/LSPlant 等开源替代 |
| **LSPlant** | LSPosed 团队 | 融合前面几家思路的"新一代"实现,专为 LSPosed 打造,同时做了**方法去内联(deoptimize)**——防止目标方法因为被 JIT 内联优化,导致 hook 回调"根本没被调用"这种坑 | 目前 LSPosed 官方在用、维护最活跃,是"当前技术水平最高"的 ART hook 引擎 |
| **Dobby** | jmpews | **不是** ART hook 引擎,而是**纯 native 层的 inline hook 库**(跨平台：Android/iOS/Linux/Windows,支持 ARM/ARM64/x86/x64),做法就是第一节讲的"改函数开头几字节为跳转指令" | 常被用来 Hook `.so` 里的 C/C++ 函数(比如报告里提到的 `xhook` 也是同类定位),和 Frida 的 `Interceptor` 是同类竞品/替代 |

**记忆窍门**：前 5 个(YAHFA/pine/SandHook/Epic/LSPlant)都是**"Java 方法级"** 的 ART hook 引擎,解决的是第四节的 `ArtMethod` 问题;Dobby/xhook 是 **"native 函数级"** 的 inline hook 库,跟 Frida 的 `Interceptor` 属于同一层次——**两者经常被同一个壳/hook 框架同时用上**(比如报告提到 MT 2.26.4 版本"libmtprotect + lsplant(ART hook)+ xhook(native inline hook)"同时出现,就是"Java 层 + native 层"双管齐下的典型配置)。

---

## 九、LSPatch / NPatch：免 root,把 Xposed 塞进 APK 本体

前面讲的 LSPosed/EdXposed 有个硬门槛——**必须 root + Magisk**。绝大多数普通用户手机是不 root 的,那怎么在不 root 的手机上用 Xposed 模块?答案是 **LSPatch**。

### 9.1 核心思路：既然不能改系统,那就改这一个 APK

LSPatch(LSPosed 团队出品,"non-root Xposed" 的定位)的做法是：

1. 拿到目标 APK,**在 APK 内部塞进**一份"迷你版 LSPosed 运行时"(包含 hook 引擎、模块加载器等);
2. 修改 APK 的 `Application` 入口(手法与 [12](12-违规改机链路6环.md) 提到的"移花接木"思路一致——都是抢占最早执行的入口点),让**这个 APK 自己启动时**,先把内嵌的 LSPosed 迷你运行时跑起来,再加载你指定的 Xposed 模块对**这一个 App 自己**做 hook;
3. 重新签名,安装即可用——**全程不需要 root、不需要 Magisk、不需要碰系统分区**。

代价是：**必须改这一个 APK 的文件本体**(不像系统级 LSPosed 那样"一次装好,所有 App 自动生效"),而且改包之后签名必然发生变化(见 [05](05-APK签名体系-v1v2v3v4.md)),所以配套需要"签名绕过"能力——这就是为什么报告里 MT/NP 一旦怀疑内嵌了 LSPatch,同时也一定会看到"签名校验被搞定"。

### 9.2 Embed 模式 vs Manager 模式

LSPatch 提供两种把模块塞进 APK 的方式：

- **Embed 模式**(`-m`/`--embed`)：把 Xposed 模块**打包死**进这一份 APK 里,模块和宿主 APK 绑死,要更新模块就得重新 patch 一次。**报告里提到的"LSPatch v6 嵌入式攻击链"用的就是这个模式**——把伪造签名逻辑、VIP 资源包都塞进一个 APK,一次分发,开箱即用,不依赖用户手机上再装别的东西。
- **Manager 模式**(`--manager`)：不把模块打死,而是让 patch 后的 APK 在运行时去找手机上安装的 **LSPatch Manager**(一个独立 App)要模块——好处是模块可以独立更新,坏处是用户必须额外装一个 Manager App,不如 Embed 模式"一个 APK 搞定"来得隐蔽和省心。

### 9.3 sigBypassLevel：签名伪装的"力度旋钮"

LSPatch 内置一个叫 `sigBypassLevel` 的配置项(整数,默认 0),控制"要不要、以及用多强的手段"去伪造这个 patch 后 APK 对外汇报的签名信息,级别越高,伪造越彻底(比如让 App 查询到的签名看起来和"原版未改动"一模一样),对应也越容易被"签名+完整性交叉校验"的高级检测揪出来(因为伪造得越像,静态特征往往留得越多,或者伪造链路本身的调用点越容易被日志/hook 检测捕捉,见 [14-防御方视角](14-防御方视角-检测与加固.md))。报告里提到的 NP `PatchConfig` 里出现 `sigBypassLevel/originalSignature/appComponentFactory/lspConfig` 这几个字段,和 LSPatch 源码里的配置项**逐字吻合**,是判断"这个改机 APK 疑似内嵌了 LSPatch"的关键取证线索。

### 9.4 NPatch:LSPatch 的社区复刻版

**NPatch**(`7723mod/NPatch`)是社区在 LSPatch 基础上做的复刻/分支,思路和实现高度一致(同样是"以 LSPosed 为基础的免 root Xposed 框架"),报告和一些破解教程里把 LSPatch/NPatch 并列提及,基本可以理解为"同一件事的两个具体实现"。

---

## 十、全景对照表：要不要 root / 改 APK / 常驻进程

把本篇讲的几种方案放在一张表里,你会发现它们其实是**同一个"运行时改行为"目标下的不同权衡取舍**:

| 方案 | 需要 root? | 需要改 APK 本体? | 需要常驻/额外进程? | 覆盖范围 | 典型定位 |
|---|---|---|---|---|---|
| **Frida(Attach 模式)** | 需要 | 不需要 | 需要(`frida-server` 常驻) | 单次 attach 的目标进程 | 分析/取证,临时性最强 |
| **Frida(Gadget 模式)** | 不需要 | **需要**(塞 `frida-gadget.so`) | 不需要额外进程(gadget 自带) | 这一个 App | 免 root 场景下的动态分析 |
| **LSPosed(依托 Zygisk)** | 需要 | 不需要 | 需要 Magisk/Zygisk 常驻框架 | **系统里所有 App**(zygote 注入,一次装好全局生效) | 长期、系统级、面向"框架"而非单个 App |
| **EdXposed(依托 Riru,已停止维护)** | 需要 | 不需要 | 需要 Riru 常驻 | 系统里所有 App | 历史方案,不再推荐 |
| **LSPatch / NPatch(Embed 模式)** | **不需要** | **需要**(改这一个 APK) | 不需要额外进程(运行时嵌在包内) | 只有**这一个**被 patch 过的 APK | 免 root 场景下"对单个 App 长期生效"的折衷方案 |
| **纯静态 patch**(见 [11](11-签名校验绕过全景.md)) | 不需要 | **需要**(改字节码/资源后重新打包) | 不需要 | 只有这一个 APK | 完全离线、不依赖任何运行时框架 |

看这张表你会发现一个规律：**"要不要 root"和"要不要改 APK 本体"几乎是跷跷板的两端**——不想 root,就得把 hook 能力嵌进 APK 文件本身(LSPatch);想让所有 App 自动生效、不碰任何一个 App 的文件,就得拿到系统级权限(root + Zygisk)。这也是报告里那句"**机制可替代,'一键+小 footprint+隐蔽'的组合不可替代**"的技术根源——**免 root 免改包**这两个诉求本身就有工程上的张力,鱼与熊掌不可轻易兼得。

---

## 十一、防御方怎么看：检测的抓手在哪

这几套方案都不是"隐形"的,留下的痕迹各不相同,是 [14-防御方视角](14-防御方视角-检测与加固.md) 的重点素材,这里先点几个和本篇直接相关的：

- **进程内存里的可疑 `.so`**:Frida 的 `frida-agent.so`、LSPosed 的 Xposed 相关 so、Zygisk 加载的模块 so,都会出现在目标进程的 `/proc/self/maps`(进程内存映射表——你可以理解为"这个进程都映射了哪些文件到内存的哪段地址",类似 Linux 下 `/proc/<pid>/maps`)里,名字或路径往往带有特征字符串。
- **`ArtMethod` 字段异常**：如果一个明明是纯 Java 写的方法,却发现它的 `access_flags_` 被打上了 `kAccNative` 标志、`entry_point_from_quick_compiled_code_` 指向一个不属于任何已加载 so 的地址,这基本实锤是被 ART hook 过。
- **LSPatch 五件套**(报告原话):патch 后 APK 特有的文件/字段特征(比如自定义的 `appComponentFactory`、内嵌的 loader 资源、`sigBypassLevel` 相关配置字段)——静态扫描 APK 就能揪出来,不需要动态运行。
- **端口/进程名探测**:`frida-server` 默认监听固定端口、进程名/线程名有典型特征,是最初级、最容易被绕过、但也最常被简单检测脚本使用的手段。
- **完整性上移到服务端**(治本)：报告和 [14](14-防御方视角-检测与加固.md) 反复强调的思路——**Hook 能改本地任何返回值,但改不了"服务端根据你上报的环境指纹独立做出的判断"**,把关键校验结果参与业务解密、绑定服务端 nonce,是让"Hook 绕过检测"本身贬值的根本对策。

---

## 一页速记

- **Hook = 运行时偷梁换柱**：调用方代码不变,被调用的实际代码被换掉。类比 `LD_PRELOAD`/改 GOT/`Detours`。
- **ART 里 Hook 的对象是 `ArtMethod` 结构体里的函数指针**(尤其是 `entry_point_from_quick_compiled_code_`),套路是"打 `kAccNative` 标志 + 换 entry point + 备份原方法"——本质仍是"改函数指针",只是壳子从"内存地址"变成"虚拟机结构体字段"。
- **zygote 是所有 App 的 fork 母体**(类比 prefork server),能在 zygote 环节插一脚,就能让"所有 App 自动被注入"——Riru(已废弃)/ Zygisk(现役)解决的正是"怎么安全插这一脚"。
- **Frida**：临时性最强的动态插桩工具,靠 `ptrace` 完成一次性注入后即脱离,靠 `frida-gum` 的 `Interceptor`/`Stalker` 做具体 hook/追踪;Attach 模式不改 APK 但要常驻 `frida-server`,Gadget 模式反过来。
- **Xposed 谱系**:Xposed(改 `app_process`,只支持 Dalvik)→ EdXposed(依托 Riru,已停止维护)→ **LSPosed**(依托 Zygisk,引擎 LSPlant,当前主流)。
- **hook 引擎盘点**:YAHFA/pine/SandHook/Epic/LSPlant 是"Java 方法级" ART hook;Dobby/xhook 是"native 函数级" inline hook,两层经常同时出现。
- **LSPatch/NPatch**：免 root 方案,代价是要改这一个 APK 本体;Embed 模式打死模块(一个 APK 全搞定,报告攻击链用的这个),Manager 模式模块可独立更新;`sigBypassLevel` 是"签名伪装力度"的旋钮。
- **要不要 root vs 要不要改 APK,是工程上的跷跷板**——这也是为什么"免 root + 免改包 + 一键"三者很难同时做到。

---

## 延伸阅读

- 本系列：[06-签名校验与防篡改](06-签名校验与防篡改.md) · [11-签名校验绕过全景](11-签名校验绕过全景.md) · [12-违规改机链路6环](12-违规改机链路6环.md) · [14-防御方视角-检测与加固](14-防御方视角-检测与加固.md) · [13-产品与项目360词典](13-产品与项目360词典.md)
- 深度专文：`../安全审计-MT一键过签名校验-机制逆向与正向实现路径.md`(`PmsHookApplication`/pine 实战细节)· `../安全审计-签名校验绕过-开源工具全景与检测.md` · `../安全审计-MT与NP管理器-全功能逆向分析总报告.md`
- 官方/社区项目：[LSPosed/LSPlant](https://github.com/LSPosed/LSPlant) · [LSPosed/LSPosed](https://github.com/LSPosed/LSPosed) · [LSPosed/LSPatch](https://github.com/LSPosed/LSPatch) · [canyie/pine](https://github.com/canyie/pine) · [PAGalaxyLab/YAHFA](https://github.com/PAGalaxyLab/YAHFA) · [7723mod/NPatch](https://github.com/7723mod/NPatch) · [Frida 官方文档 · Modes of Operation](https://frida.re/docs/modes/) · [Frida 官方文档 · Stalker](https://frida.re/docs/stalker/)
