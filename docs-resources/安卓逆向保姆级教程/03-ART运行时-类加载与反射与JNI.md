
# ART 运行时：类加载、Application、继承链、反射、JNI

> 一句话点题：安卓里几乎所有"注入/hook/绕过"手法,归根结底都是在利用 ART(安卓的虚拟机)**装载代码、初始化对象、按名字找符号**这三件事天生"来者不拒"——本篇把这三件事从底层机制讲透,你会发现《总报告》里那些"移花接木""killPM""HiddenApiBypass"突然全都讲得通了。

> 本篇是 [00-教程总纲与术语总表](00-教程总纲与术语总表.md) 第一部分的第 3 篇,前置知识见 [01-安卓App骨架-APK与DEX与ART.md](01-安卓App骨架-APK与DEX与ART.md)(DEX 是什么、ART 是什么虚拟机)和 [02-DEX字节码与Smali汇编.md](02-DEX字节码与Smali汇编.md)(smali 语法,本篇会用到 `.super` 这个 smali 关键字)。读完本篇再回头看《[MT一键过签名校验-机制逆向](../安全审计-MT一键过签名校验-机制逆向与正向实现路径.md)》和《[攻击机制图谱](../安全审计-攻击机制图谱-签名绕过与注入与原生化.md)》,里面的"移花接木""killPM"会豁然开朗。

---

## 0. 先建立一张全局地图：一个 App 启动的头 10 毫秒发生了什么

你熟悉的 C/C++ 程序启动顺序大概是：`execve` → 动态链接器解析依赖 `.so` → 跑各个 `.so` 里 `__attribute__((constructor))` 标记的初始化函数 → 跳到 `main()`。

安卓 App(准确说是"进程")的启动顺序,概念上完全平行,只是角色换了名字：

```
zygote fork 出新进程
   │
   ▼
ART 虚拟机在这个进程里就绪(相当于"运行时环境已备好")
   │
   ▼
ClassLoader 建立起来 ──────────────► 【本篇 §1】"动态链接器"就位
   │  (知道去哪个 dex 里找类)
   ▼
系统 new 一个 Application 子类实例
   │  (这一步会触发这条继承链上所有类的 <clinit>)
   ▼                                 ►【本篇 §2】<clinit> 自动执行
Application.attachBaseContext()  ──► 【本篇 §3】比 Activity 更早的钩子
   │
   ▼
Application.onCreate()
   │
   ▼
第一个 Activity 才开始创建、显示界面
```

而"继承链"(§4)、"反射"(§5)、"隐藏 API 限制"(§6)、"JNI"(§7)都是穿插在这条主线里的**机制**,不是独立的步骤——它们是"改包的人"用来在这条主线上"打洞"的工具。带着这张图往下看,每一节讲完你都能指出它在图里的哪个位置起作用。

---

## 1. ClassLoader：安卓的"动态链接器"

### 1.1 是什么、为什么存在

C/C++ 程序里,你写的 `dlopen("libfoo.so", RTLD_NOW)` + `dlsym(handle, "some_func")` 干的事是：**在运行时**去找一个共享库,把它映射进内存,再按名字找到里面的符号(函数/变量)地址。这一整套东西在 Linux 上由动态链接器(`ld.so`)负责。

Java/ART 世界的等价物就是 **ClassLoader**。区别是：C++ 的 `.so` 装的是**已经编译好的机器码**,而 ClassLoader 装的是 **DEX 字节码**——但"找到、加载进内存、建立可调用的符号表"这套流程是一模一样的心智模型。没有 ClassLoader,虚拟机看到 `new Foo()` 根本不知道 `Foo` 这个类长什么样、字节码在哪。

### 1.2 怎么工作：双亲委托模型

和 Linux 动态链接器查找 `.so` 有一套搜索顺序(`LD_LIBRARY_PATH`、`RPATH`、系统默认路径……)类似,ART 的 ClassLoader 也有一套查找顺序,叫**双亲委托模型(Parent Delegation)**:

```
BootClassLoader        (加载 android.*、java.* 这些"系统库",相当于 libc/libstdc++)
      ▲
      │ 委托
PathClassLoader        (加载你这个 App 自己 APK 里的 classes.dex,相当于加载主程序自身)
      ▲
      │ (可选)
DexClassLoader / InMemoryDexClassLoader   (加载"额外的" dex,不在原 APK 里)
```

规则很简单：**收到"帮我找类 X"的请求时,先问父加载器有没有,父加载器没有才自己找**。这和 C++ 里"先查已加载的符号表,再查新库"的顺序逻辑是一回事,目的也一样：避免同名类/符号被意外覆盖、保证系统类只有一份权威版本。

### 1.3 PathClassLoader vs DexClassLoader：这俩到底差在哪

| | 类比 | 用途 |
|---|---|---|
| **PathClassLoader** | 加载"主程序自身"的默认链接器行为 | 系统默认用它加载你 APK 里 **已安装** 的 dex,路径固定、由系统管 |
| **DexClassLoader** | 手动 `dlopen()` 一个"不在标准搜索路径里"的库 | 你的 App **主动在运行时**去加载一个不在自己 APK 内的 dex 文件(比如从 SD 卡、从网络下载的文件里加载代码) |
| **InMemoryDexClassLoader**(API 26+) | 相当于 `dlopen` 一段**内存里的字节流**而不是磁盘文件 | 直接把解密后的 dex 字节数组丢进去加载,**磁盘上不留任何明文 dex 文件** |

### 1.4 在逆向里扮演什么角色

- **热更新/插件化框架**(如早年的 Tinker、DynamicAPK)靠 `DexClassLoader` 在运行时加载补丁 dex——这本是合法的工程手段。
- **加壳(壳)恰好滥用了同一套机制**：把真正的业务 dex 加密塞进 assets,进程启动后先解密到内存,再用 `InMemoryDexClassLoader`(或较老壳用 `DexClassLoader` 配合临时文件)加载——这样磁盘上、`classes.dex` 里看到的都只是一层"壳"代码,真正逻辑要等运行时才现身。这正是《[加固实施清单](../安全审计-加固实施清单-把App推进C档.md)》里"加壳"要解决的问题的技术根子,详见 [09-混淆与加固与脱壳.md](09-混淆与加固与脱壳.md)。
- **正因如此,"脱壳"这件事在原理上就是**：在 ClassLoader 真正吃到解密后的 dex 字节的那一刻,把内存里的这段字节 dump 下来——不管壳把它包装得多花哨,最终一定要走 `ClassLoader.loadClass`/`defineClass` 这一步,这是它绕不开的"必经之路"。《总报告》里提到的"ART 层 hook ClassLoader/InMemoryDexClassLoader 在内存 dump"说的就是这个原理。

### 1.5 防御方怎么检测

- 静态审计：全局搜 `DexClassLoader`/`InMemoryDexClassLoader`/`PathClassLoader` 构造调用点,尤其是参数指向 `assets/`、私有目录、SD 卡的可疑路径——这几乎是"这个 App 会在运行时偷偷加载一份 dex"的铁证。
- 动态检测：hook `ClassLoader.loadClass`/`defineClass`/`InMemoryDexClassLoader.<init>`,记录每次实际被加载的类名和来源,用来对账"清单里声明的类"和"运行时真正跑起来的类"是否一致。

---

## 2. 类初始化与 `<clinit>`：免费的"进程构造函数"

### 2.1 是什么

你在 C++ 里写过这样的代码：

```cpp
struct AutoInit {
    AutoInit() { do_something_at_startup(); }
};
static AutoInit g_init;   // 全局对象,main() 跑之前构造函数就执行了
```

这靠的是编译器把 `AutoInit::AutoInit()` 的调用塞进了 ELF 的 `.init_array` 段,`ld.so`/CRT 启动代码会在 `main()` 之前逐个跑一遍。

Java/DEX 里有个等价机制,叫**类的静态初始化块**,编译后会被打包成一个特殊方法,固定名字叫 **`<clinit>`**(class initialization 的缩写,读作 "clinit")。凡是你写的：

```java
class Foo {
    static { doSomethingAtClassLoad(); }      // 静态初始化块
    static int x = computeX();                 // 静态字段初始化
}
```

编译器都会把它们**按源码顺序**拼进 `Foo` 这个类的 `<clinit>()` 方法里。这方法你永远不会手写调用它——它是虚拟机在"某个时机"自动调用的,类似 ELF 的 `.init_array`。

### 2.2 什么时机触发(这是关键)

Java 语言规范定义了几种会触发一个类**首次**初始化(从而跑一次 `<clinit>`,且只跑一次)的情况,记住最常见的三种就够用：

1. **`new` 这个类的实例**——虚拟机要保证类初始化过才能造对象;
2. **访问这个类的静态字段/调用静态方法**(常量除外);
3. **反射主动触发**,比如 `Class.forName("com.foo.Bar")` 默认就会触发初始化(这也是为什么"反射加载"经常被当作触发点故意利用,§5 会细讲)。

另外还有一条对本篇特别重要：**子类初始化之前,虚拟机会先保证它的父类已经初始化过**。也就是说,只要子类被 `new` 了一次,**整条继承链上从 `Object` 往下的每一层父类的 `<clinit>` 都会被依次跑一遍**——这条规则就是 §4 "移花接木"能成立的根本原因,先记住这句话。

### 2.3 为什么这是"注入代码自动执行的黄金点"

站在"想往一个 App 里塞代码"的人的角度想：你面临的问题是——**改包之后,怎么保证我塞的初始化代码,在 App 正常运行的某个必经之路上,不需要额外触发就能自动跑起来?**

`<clinit>` 完美解决了这个问题：只要你能让"某个类被这条继承链/调用链碰一下"(哪怕只是被 `new` 一次、被访问一次静态字段),这个类的 `<clinit>` 就**保证会跑**,不需要你去 hook 任何函数调用点、不需要改任何业务逻辑的方法体。这跟 C++ 里"塞一个全局对象让构造函数自动跑"是完全一样的思路,只是安卓的这条路径更好找——因为几乎每个 App 都有一个**保证会被最早创建的对象**：下一节要讲的 `Application`。

---

## 3. Application 对象：进程的"全局单例",比 Activity 更早

### 3.1 是什么、为什么存在

安卓 App 不是"一个个页面各自独立跑",而是**一个进程里所有页面(Activity)共享同一个 `Application` 对象**。这个对象在 `AndroidManifest.xml`(App 的"配置清单",详见 [04-资源系统-arsc与AXML.md](04-资源系统-arsc与AXML.md))里用 `android:name` 声明：

```xml
<application android:name="com.example.MyApplication" ... >
```

如果不声明,系统会用默认的 `android.app.Application`。这个对象在这个进程的生命周期里**只会被创建一次**,可以理解成：C++ 后端服务里那个"进程启动时创建、贯穿整个进程生命周期的全局单例/上下文对象"——所有模块都能拿到它的引用,拿它存全局状态。

### 3.2 生命周期：`attachBaseContext` → `onCreate`,比 `main()` 更早的两个钩子

`Application` 类提供两个你可以覆写的方法,系统会按固定顺序调用：

```
进程刚起来
   │
   ▼
attachBaseContext(Context base)   ← 最早能拿到 Context 的地方,连"应用是否已解密""包信息"都还没完全就绪
   │
   ▼
onCreate()                        ← 常规的"应用启动初始化"入口,官方推荐的初始化位置
   │
   ▼
第一个 Activity 的 onCreate() 才开始跑,用户才第一次看到界面
```

类比一下：如果把"用户看到第一屏界面"类比成 C++ 后端"服务开始对外提供接口",那么 `attachBaseContext`/`onCreate` 就相当于**进程启动脚本里,在 `accept()` 循环开始之前跑的那段初始化代码**——早于一切业务逻辑,且**全局只跑一次**。

### 3.3 为什么是"注入首选"

结合上一节的结论：如果你能让自己的代码**成为(或插入到)`Application` 这条继承链里**,那么：

- 你的初始化代码会在 App **任何业务逻辑之前**执行(因为 `<clinit>` 触发早于 `attachBaseContext`);
- 你**只需要改一处**(继承链上的一环),就能让代码在**所有场景**下都自动跑,不用挨个 hook 业务方法;
- 这是全进程唯一保证"第一个跑、且只跑一次"的对象。

所以《总报告》里几乎所有"过签名""解密自身""初始化 hook 框架"的手法,第一步永远是想办法在 `Application` 这一层插一脚。下一节讲**具体怎么插**,也就是"移花接木"。

---

## 4. 类继承链与 `.super`:"移花接木"的原理

### 4.1 先回顾 `.super` 是什么

[02-DEX字节码与Smali汇编.md](02-DEX字节码与Smali汇编.md) 里讲过,smali(DEX 反汇编出来的"汇编语言")里每个类文件开头会声明它的父类：

```smali
.class public Landroidx/multidex/MultiDexApplication;
.super Landroid/app/Application;    ← 这一行声明"我的父类是谁"
```

`.super` 就是这个类的**基类声明**,类比 C++ 里 `class MultiDexApplication : public Application`。

### 4.2 "移花接木"：只改一行 `.super`,manifest 一个字都不用动

现在把 §2.2 那条规则("子类初始化前,父类链上每一层的 `<clinit>` 都会依次自动跑")和 `.super` 结合起来看,"移花接木"这个手法就自然浮现了：

**改包的人根本不需要碰 `AndroidManifest.xml` 里 `android:name` 那一行**,他们只需要**在继承链中间插一层**——找到 App 原本就在用的某个基类(最常见的是 `androidx.multidex.MultiDexApplication`,几乎所有 App 为了突破"单 dex 65536 方法数上限"都会用它,参见 [02](02-DEX字节码与Smali汇编.md) 和 [12-违规改机链路6环.md](12-违规改机链路6环.md)),把**它自己**的 `.super` 改掉：

```
改包前:                                改包后(只改了一行 smali):

MyApplication                          MyApplication
   │ .super                               │ .super
   ▼                                      ▼
MultiDexApplication                    MultiDexApplication
   │ .super                               │ .super  ← 就改了这一行!
   ▼                                      ▼
Application (系统基类)                  KillerApplication  ← 塞进来的新基类
                                           │ .super
                                           ▼
                                        Application (系统基类)
```

效果是：`AndroidManifest.xml` 里写的还是 `android:name="com.foo.MyApplication"`,**diff 面小到只有一行 smali**,静态比对"清单里声明了什么类"完全看不出异常——但只要 App 一启动、`MyApplication` 一被创建,**整条链上的 `<clinit>` 依次触发**,新插入的 `KillerApplication.<clinit>`(以及它的 `onCreate`/静态方法)就会被**自动执行**,不需要任何显式调用。这就是"移花接木"字面意思：嫁接的枝子(`KillerApplication`)结的果子,长在了看起来还是原来那棵树(`MyApplication`)上。

《[MT一键过签名校验-机制逆向](../安全审计-MT一键过签名校验-机制逆向与正向实现路径.md)》里 `bin.mt.signature.KillerApplication` 用的正是这一招;更系统的手法总览见 [11-签名校验绕过全景.md](11-签名校验绕过全景.md)。

### 4.3 防御方怎么检测

一句话：**不能只 `grep AndroidManifest.xml` 里的 `android:name` 就下结论"没被劫持"**。必须**全局搜索所有类的 `.super` 声明**,重点看常见的"必经基类"(`MultiDexApplication`、`AppCompatActivity` 等)的父类,是否被改成了一个陌生的、非官方命名空间的类名——这是检测"移花接木"的唯一可靠办法。

---

## 5. 反射(Reflection)：按字符串名找符号并调用

### 5.1 是什么、类比什么

反射就是：**不在编译期写死类名/方法名,而是在运行时拿一个字符串,去动态查找对应的类/字段/方法,并调用它**。

```java
Class<?> clazz = Class.forName("com.foo.Bar");          // 按名字找类
Method m = clazz.getDeclaredMethod("doSomething");        // 按名字找方法
m.setAccessible(true);                                     // 绕过 private/final 的访问控制!
m.invoke(instance);                                         // 调用
```

这在你熟悉的世界里有两个类比,叠加起来才是完整画像：

- **RTTI**(`typeid`/`dynamic_cast`)：运行时知道一个对象"实际是什么类型",按类型信息做判断;
- **`dlsym`**：运行时按**字符串名字**在一个已加载的模块里找符号地址,而不是编译期静态链接。

反射就是这两者的合体,而且比 `dlsym` 更进一步——它连 **`private`/`final` 的访问限制都能绕过**(`setAccessible(true)`),这是它在逆向/破解里被大量使用的核心原因：**Java 语言层面的访问控制,是编译器/虚拟机的检查,不是操作系统级别的内存保护,反射直接把这层检查关掉了。**

### 5.2 为什么"绕签名"必须用反射：`PackageInfo.CREATOR` 案例

安卓查询"我的 App 是谁签名的"最终会走到 `PackageInfo` 这个类,它的签名信息是通过一套叫 `Parcelable`(安卓进程间传输对象的序列化机制,可以理解成"进程间 RPC 用的对象编解码协议",类似 Protobuf 但更贴近内存布局)的 `CREATOR` 静态字段来反序列化的。这个 `CREATOR` 字段是系统框架类的 **`private static final`** 字段——正常 Java 代码**没有任何合法途径**去修改它。

破解手法(`KillerApplication.killPM()`)的做法是：

1. 反射拿到 `PackageInfo`(或更底层的 `Signature`)的 `CREATOR` 字段;
2. `setAccessible(true)` 绕开 `private final` 限制;
3. `set()` 一个自己实现的、返回"伪造签名"的 `Creator` 对象替换掉它;
4. 额外还要清掉系统为了性能加的**多级缓存**(`sPackageInfoCache`/`mCreators`/`sPairedCreators` 等)——不然缓存命中会绕过你刚替换的对象,读到旧值。

这一整套操作,**除了反射没有第二种做法**——因为你面对的是系统框架内部的 `private final` 字段,编译期你连引用这个字段的代码都写不出来(编译器直接报错),必须靠反射在运行时"硬掰"。

### 5.3 防御方怎么检测

- 静态审计里,**高密度出现 `setAccessible(true)` + 反射调用系统框架包(`android.*`/`java.*`)的私有字段**,本身就是强特征;
- 具体检测 `PackageInfo.CREATOR`/`Signature.CREATOR` 是否被替换成了非系统实现的类;
- 更系统的检测清单见 [14-防御方视角-检测与加固.md](14-防御方视角-检测与加固.md) 与《[签名校验绕过-开源工具全景与检测](../安全审计-签名校验绕过-开源工具全景与检测.md)》。

---

## 6. 隐藏 API 限制与 HiddenApiBypass：反射也会被限流

### 6.1 背景：为什么会有这道限制

Android 9(API level 28)之前,反射几乎"为所欲为"——只要不是 `SecurityManager` 拦的,系统框架内部随便什么私有字段都能反射改。谷歌担心 App 过度依赖这些"非官方承诺稳定"的内部实现细节(每次系统升级都可能改内部字段名/结构,导致 App 崩溃),于是从 Android 9 起引入了**非 SDK 接口限制(Hidden API restriction)**。

机制大致是：系统维护几张"名单"(灰名单细分为 light-greylist/dark-greylist,加上 blacklist),把所有非公开 API 分门别类;是否真的拦截、拦到什么程度,取决于 App 的 `targetSdkVersion`——`targetSdkVersion` 越新,受限越严格(这是谷歌用来"倒逼"App 升级适配的杠杆,而不是一次性硬切)。

### 6.2 对破解手法的影响,以及怎么被绕过

§5.2 里 `killPM()` 反射修改的那些字段,相当一部分正好落在了受限名单里——如果不处理,反射调用会直接抛异常或返回 `null`。破解手法的应对办法是：

```java
// SDK_INT >= 28 时才需要
org.lsposed.hiddenapibypass.HiddenApiBypass
    .addHiddenApiExemptions("Landroid/os/Parcel;", "Landroid/content/pm", "Landroid/app");
```

底层原理是调用系统内部的 `VMRuntime.setHiddenApiExemptions(String[] signaturePrefixes)`——这是 ART 运行时自己留的一个"白名单前缀"配置接口：只要某个反射目标的类型签名匹配上你注册的前缀,就被当成"豁免"对待,访问限制形同虚设。

这里有个很有意思的"套娃"细节：`VMRuntime.setHiddenApiExemptions` 这个方法本身,**恰恰也是一个隐藏 API**,正常反射去调它应该也会被拦——`HiddenApiBypass`(LSPosed 团队维护的开源库)能绕开这层"元限制",靠的不是走标准反射调用路径,而是直接操作更底层的 `sun.misc.Unsafe` 之类的机制,不触发针对"标准反射调用栈"设的检查,这也是它比某些同类轻量方案(如库里另一套 `LSPass`)更稳定、能兼容到更多系统版本的原因。

### 6.3 防御方怎么检测

- 静态审计里搜索 `VMRuntime`、`setHiddenApiExemptions`、`org.lsposed.hiddenapibypass` 字符串或类名,是"这个 App/破解模块在主动绕过隐藏 API 限制"的直接证据;
- 结合 §5.3 一起看：先有反射改私有字段的迹象,再看是否伴随了 HiddenApiBypass 调用,两者同时出现基本可以坐实。

---

## 7. JNI:Java 世界与 native 世界之间的桥

### 7.1 是什么、类比什么

到目前为止讲的都是"纯 Java/DEX 世界"里的把戏。但安卓 App 也可以有 `.so`(和 Linux 上的 `.so` 是**同一种 ELF 格式**,详见 [01](01-安卓App骨架-APK与DEX与ART.md))——那 Java 代码怎么调用 `.so` 里的 C/C++ 函数?答案就是 **JNI(Java Native Interface)**。

JNI 在概念上就是你熟悉的 **FFI(Foreign Function Interface)**,或者你写 `extern "C"` 导出符号给别的语言调用——都是解决"两种不同运行时/调用约定之间怎么互相调对方的函数"这个问题。

### 7.2 怎么工作：加载、注册、声明,三件套

**第一步,加载 `.so`**,等价于 `dlopen`:

```java
static {
    System.loadLibrary("mylib");   // 实际去找 lib/<abi>/libmylib.so 并加载
}
```

这行代码通常就写在某个类的静态初始化块里——没错,又是 §2 讲的 `<clinit>`,加载 native 库这件事本身也常常挂在这个"自动触发点"上。

**第二步,`.so` 被加载时,ART 会找一个特殊的导出符号 `JNI_OnLoad`**,如果存在就自动调用它——这等价于 ELF 里 `.init_array`/`__attribute__((constructor))` 跑的那个"库加载时自动执行"的钩子。开发者通常在这里做初始化,以及**注册 native 方法**。

**第三步,声明哪些 Java 方法的"函数体"其实在 native 里**:

```java
public native void doWork(int x);   // 只有声明,没有方法体——方法体在 native 一侧
```

对应关系(也就是"这个 Java native 方法调用时,到底该跳到 `.so` 里哪个函数")有两种建立方式：

| 方式 | 类比 | 特点 |
|---|---|---|
| **静态注册** | 按固定命名规则导出符号,类似 `extern "C" void Java_com_foo_Bar_doWork(...)` | 函数名里编码了完整 Java 包名+类名+方法名,**静态分析(nm/jadx 对照)一眼就能配对上** |
| **动态注册 `RegisterNatives`** | 手动构造一张"函数指针表"塞给虚拟机,类似手写一份 vtable/跳转表 | native 侧函数名可以随便起(甚至叫 `sub_1234`),**静态分析看不出这个 native 方法实际对应哪个 C 函数**,必须动态运行、hook `RegisterNatives` 调用时传入的函数指针表才能配对 |

### 7.3 过边界的开销,以及在逆向里扮演的角色

每次 Java ↔ native 互相调用,都要经过 JNI 层做**参数封送(marshalling)**——把 Java 对象/数组转换成 native 能识别的表示、处理异常传递、维护局部/全局引用防止 GC 提前回收等等。这个开销和你在后端里"跨进程 RPC 一次调用"的量级类似(远比一次普通函数调用重),所以：

- **正常 App** 只会把真正需要用 native 实现的部分(图形渲染、编解码、性能敏感算法)放在 native 层,不会为了几行逻辑就频繁"过边界";
- **加固/Dex2C 类工具反其道而行之**：故意把**关键 Java 方法整个搬到 native 里去**,Java 侧只留一个空壳方法体转发调用——这样做的核心目的不是性能,而是**让 jadx/apktool 这类只看得懂 DEX 字节码的静态工具彻底失明**：方法逻辑变成了 ELF 里的机器码,得上 IDA/Ghidra 分析,难度直接从"读 Java 源码"跳到"读汇编"。这正是《[方法原生化Dex2C-原理保姆级详解](../安全审计-方法原生化Dex2C-原理保姆级详解-给后端工程师.md)》整篇讲的机制,详细展开见 [10-方法原生化-Dex2C与VMP.md](10-方法原生化-Dex2C与VMP.md)。
- 结合 §7.2 的"动态注册"手法：如果 Dex2C/加壳工具连符号名都不想留(用 `RegisterNatives` 而不是编译器默认的静态注册命名),静态分析连"这个 native 方法对应 `.so` 里哪个函数"都对不上号,必须动态 hook `JNI_OnLoad`/`RegisterNatives` 调用时传入的方法表,才能拿到真实映射关系——这也是 [08-动态分析与Hook.md](08-动态分析与Hook.md) 里 Frida 一类工具存在的意义之一。

### 7.4 防御方怎么检测

- 静态审计：统计一个类里 `native` 方法的比例异常升高、`.so` 体积/符号数异常,是 Dex2C/加壳的强信号(具体特征库见 [09](09-混淆与加固与脱壳.md) 和 [10](10-方法原生化-Dex2C与VMP.md));
- 动态审计：hook `JNI_OnLoad` 和 `RegisterNatives`,dump 出运行时真实建立的"Java 方法 ↔ native 函数地址"映射表,弥补静态分析在动态注册场景下的盲区。

---

## 一页速记

| 机制 | 一句话 | C++/后端类比 | 在逆向里的角色 |
|---|---|---|---|
| ClassLoader(PathClassLoader/DexClassLoader) | 运行时按需加载 dex 到内存 | `dlopen` + 双亲委托式符号查找顺序 | 加壳靠它在内存里"变出"真正的业务 dex;脱壳靠 hook 它拿到明文 |
| `<clinit>`(类初始化) | 类首次被"碰"(new/访问静态成员/反射)时自动跑一次的方法 | 全局对象构造函数/ELF `.init_array` | "不用显式调用就自动执行"的黄金注入点 |
| Application(`attachBaseContext`→`onCreate`) | 进程内唯一、最早创建的全局对象 | 进程 `main()` 之前的初始化钩子 | 注入首选：一次插入,全进程生效 |
| `.super` 继承链 / 移花接木 | 改中间基类的父类声明,manifest 零改动 | 换掉某个基类的实现,子类"浑然不知" | 静态审计必须全局查 `.super`,不能只看 manifest |
| 反射 Reflection | 按字符串名找符号,`setAccessible` 绕开访问控制 | RTTI + `dlsym`,但能穿透 `private/final` | `PackageInfo.CREATOR` 之类的伪造签名必经手段 |
| 隐藏 API 限制 / HiddenApiBypass | API28+ 分级名单限制非公开反射 | 类似给 `dlsym` 加白名单前缀过滤 | 破解代码常配合反射一起出现,是强审计特征 |
| JNI | Java↔native 调用桥 | FFI / `extern "C"` | Dex2C/加壳借它把逻辑搬进 `.so`,动态注册还能隐藏符号对应关系 |

## 延伸阅读

- 前置：[01-安卓App骨架-APK与DEX与ART.md](01-安卓App骨架-APK与DEX与ART.md)、[02-DEX字节码与Smali汇编.md](02-DEX字节码与Smali汇编.md)
- 后续：[04-资源系统-arsc与AXML.md](04-资源系统-arsc与AXML.md)、[08-动态分析与Hook.md](08-动态分析与Hook.md)、[09-混淆与加固与脱壳.md](09-混淆与加固与脱壳.md)、[10-方法原生化-Dex2C与VMP.md](10-方法原生化-Dex2C与VMP.md)、[11-签名校验绕过全景.md](11-签名校验绕过全景.md)
- 深度专文：《[MT与NP管理器-全功能逆向分析总报告](../安全审计-MT与NP管理器-全功能逆向分析总报告.md)》、《[MT一键过签名校验-机制逆向与正向实现路径](../安全审计-MT一键过签名校验-机制逆向与正向实现路径.md)》、《[攻击机制图谱-签名绕过与注入与原生化](../安全审计-攻击机制图谱-签名绕过与注入与原生化.md)》、《[方法原生化Dex2C-原理保姆级详解](../安全审计-方法原生化Dex2C-原理保姆级详解-给后端工程师.md)》
- 外部参考：[LSPosed/AndroidHiddenApiBypass](https://github.com/LSPosed/AndroidHiddenApiBypass)(HiddenApiBypass 开源实现)
