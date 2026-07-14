---
name: moded-apk-crack-audit
description: 对被违规 mod 的安卓 APK 做只读取证审计(重建被攻破路径+攻击者工具/流程+加固建议)时使用。强制"先看文件名和证书猜、再 grep 验、遇原生化/加固/注入诚实止损"。Triggers on："破解审计"、"篡改 apk"、"mod apk 分析"、"会员/vip 解锁怎么做的"、"去广告版原理"、"这个 apk 被怎么改的"、"重打包/重签识别"、"加固/壳识别"、"注入模块/xposed/lspatch"。防御/取证视角,不产再破解配方。
license: CC-BY-4.0
metadata:
  author: Jiacheng Li
  version: 1.0.0
  audience: "local LLM (小参数, 易发散/易幻觉)"
  reference: "安全审计-moded-APK审计方法论与套路总纲.md (同目录,操作主脑) + 5 份专题"
  distilled_from: "apk-2 目录 99 个真实 mod-APK 审计"
  compliance: "只读取证/防御视角;只重建攻击面+加固,不含可复用再破解步骤/patch"
---

# moded APK 破解审计 — Skill 协议

> 本 skill 是**决策树 + 索引**;完整方法论见 `安全审计-moded-APK审计方法论与套路总纲.md`。
> 面对"这个 mod-APK 被怎么破的 / 怎么加固"类任务,**先读 §0 心法与 §3 止损铁律再行动**。
> 合规:纯只读、防御视角,产出"如何被攻破 + 如何加固",**不写可照做的再破解步骤/patch**。

## §0 心法(治小模型两大错)
> **先用文件名和证书"猜",再用 grep"验",遇原生化/加固/注入就"诚实止损"——绝不据"没搜到"断言"没有"。**
- 别只试 `isVip` 一个锚点就放弃(判定名随 App 变,一次多试一组)。
- grep 不到 ≠ 不存在:先怀疑被原生化/加固/注入(§3)。

## §1 七步流程
1. 元数据 `aapt dump badging`;**读文件名解码**(应用名/版本/破解类型/作者)。
2. 签名 `apksigner verify --print-certs` → 证书 DN **猜作者与手法**(见总纲 §2.2 速查表);v1/v2/v3;原签名是否被破坏。
3. 反编译 `apktool d`(失败→ unzip + baksmali/strings 兜底)。
4. **按破解类型分流** grep(见 §2),别盲搜。
5. 命中→读方法体确证;**干净得反常→查 §3 原生化/注入指纹→止损**。
6. 推断工具(apktool/MT/NP/LSPatch/Dex2C/云镜…),诚实标 [确证]/[推断]。
7. 四段式产出:破解点 / 手法 / 调用链 / 加固 + 证据与不确定性。

## §2 按类型的首选 grep 锚点
| 类型(看文件名) | 先 grep |
|---|---|
| 会员/VIP版 | `isVip\|isMember\|getMember\|USER_IS_VIP\|会员\|isSvip` |
| 高级/Pro/专业版 | `isPro\|isPremium\|isPlus\|hasPremium\|isPurchased\|productType\|entitlement` |
| 解锁完整/解锁版 | `checkLicense\|checkLicenseOnBackend\|licensing\|isLicensed`(挑最底层网关/旧链路,查 fail-open) |
| 去广告/免广告版 | 广告 SDK 包名 `pangle\|bytedance\|gdt\|admob\|gms.ads\|gromore\|topon\|Splash\|Interstitial`;或走注入 |
| 内置X模块/纯净版 | manifest `appComponentFactory`/`*InitProvider`;`lib/*` Hook 引擎 so |

## §3 止损铁律(治幻觉,最重要)
见到以下 → 具体 patch 多在 native,**静态到界,如实标注"已原生化/在壳内/运行时 Hook,纯静态不可还原",给出已确证的机制边界,别编完整调用链**:
`libstub.so` / `.source "YJ-Dex2C"` / `yjaq.xyz` / `libcxapkmod.so` / `.Epic` dex 分片 / `ijiami`(爱加密) / `com.stub.StubApp`(360) / `liblshook·libpine·libEpic`(ART Hook) / `ApkSignatureKillerEx·KillerApplication`(签名绕过)。
> 审计可信度来自诚实标 [确证]/[推断],不是"看起来查全了"。

## §4 深挖索引(同目录)
- 方法论主脑:`安全审计-moded-APK审计方法论与套路总纲.md`
- 作者→手法:`安全审计-攻击者画像-模组作者与工具链.md`
- 机制原理与指纹:`安全审计-攻击机制图谱-签名绕过与注入与原生化.md`
- 排查决策树:`安全审计-破解类型与排查方向.md`
- 防御加固:`安全审计-加固对策手册.md`

> 运行时:rev-agent 已把上述套路作为 `crack-audit / mod-sig-bypass / mod-native-hidden / mod-inject-module / mod-adfree` seed playbook(硬信号触发、只作参考 context)注入,见 `src/playbook.ts`。
