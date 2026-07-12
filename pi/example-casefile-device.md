# 前置强模型分析案卷(Device Info Premium mod)

## Case-File: Device Info Premium mod 版 pro 绕过定位

> 源码根: `/Volumes/zhitai-7100/reverse-agent/apk-moded/device-jadx/sources`
> 结论已由 4 路并行搜索交叉印证 + 我本人 Read 复核了 op4.java:60-89 / 485-539（两处锚点 100% 命中，非幻觉）。
> 结论一句话: **mod 不伪造 billing、不删 License 校验，而是把"全局唯一的 ad-free/pro 权益布尔"在源头改成恒真。**

---

### 1. 最可能的破解点（按置信度排序）

| # | 破解点(类.方法) | file:line | 手法 | 置信度 |
|---|---|---|---|---|
| **A(主)** | `op4.op4(Context)` 构造器 | `defpackage/op4.java:71-72` | 读了 `getBoolean("is_ad_free", false)` 但**丢弃返回值**(死读, 第71行), 紧接 `new kr1(true)` 硬编码把权益 StateFlow 播种为 true(第72行)。原版应是 `new kr1(getBoolean("is_ad_free",false))`。**弃读残留 = smali const-patch 的经典指纹。** | **high(已Read复核)** |
| **B(副)** | `op4.n(boolean z)` 权益写入器 | `defpackage/op4.java:529-539`(关键 534/538) | 忽略入参 `z`, 无条件 `putBoolean("is_ad_free",true).putBoolean("billing_synced",true)`(534) + `kr1.e0(null,true)`(538)。故连 Splash 的 `n(false)`("未购买"路径)也会写 true, 让解锁**跨重启粘住**。 | **high(已Read复核)** |
| 读取点 | `op4.l()` 全局 pro 判定 getter | `defpackage/op4.java:489-491` | `return ((Boolean)((kr1)this.s).c0()).booleanValue();` 读的就是 A 播种为 true 的 flow → **恒真**。全 app 的 pro/ad-free 闸门都读它。 | high(已Read复核) |
| 反证 | 同类型正常默认 | `defpackage/u3.java:14` | 无关 flag 用 `new kr1(Boolean.FALSE)`, 证明此类 StateFlow 正常默认 false → op4:72 的 `new kr1(true)` 是被翻的异常初始化。 | medium(搜索报告, pi可核) |

---

### 2. 去混淆映射(defpackage 短名 → 真实身份)

| 混淆名 | 真实身份 | 证据 file:line |
|---|---|---|
| `op4` (q==1 分支) | **"ad_entitlement" 权益管理器**(SharedPreferences 文件名 `ad_entitlement`, key `is_ad_free`) — pro/去广告统一权益的持有者。**破解点就在这里。** | op4.java:67-75 |
| `kr1` | kotlinx **MutableStateFlow**(构造存 `_state$volatile`, `c0()` 读回)。`new kr1(true)` = 权益从进程启动即为 true。 | kr1.java:13-15(ctor), 55-63(c0) |
| `op4.l()` | 全局 **pro/ad-free 判定 getter**(恒真) | op4.java:489 |
| `op4.n(bool)` | 权益 **setter/授予入口**(被 patch 成恒写 true) | op4.java:529-539 |
| `op4.v` / `f90.m(Context)` | op4 单例工厂(懒建 `new op4(appCtx)` 缓存到 op4.w) — 保证被 patch 的那个实例是全局唯一活实例 | f90.java:466-486 |
| `u3` | **广告控制**(`u3.b()` = 是否展示广告的谓词) | u3.java:32 |
| `oq1` (tc1) | **BillingClient 购买回调监听**(a()/c() 都调 op4.n(true)) — 合法解锁路径, mod 中冗余 | oq1.java:13-26 |
| `p62` | **真实 GoogleBillingService**(真建 Play BillingClient, SKU: donate_coffee/sandwich/lunch/huge, 真 launchBillingFlow) — **未被 stub, 不是攻击点** | p62.java:107-109,148 |
| `gx0` | 菜单控制(remove-ads 菜单项显隐) | gx0.java:106-110 |
| `x22` | 测试/传感器列表(是否插 "Ad" tile) | x22.java:553-558, 611 |
| `y60/w60/x60` | DonateActivity 的捐赠 UI 监听器(与破解无关) | — |
| `gn1` | SettingsFragment(仅导航, 无闸门) | — |
| `lh2/l04` | 仅命中泛化 BillingClient 引用, **非破解点** | — |

> 纠偏给 pi: 题面点名的 `lh2/y60/gn1/l04/p62/w60` 里, **没有一个是破解点**。它们只是 billing/UI 外围。真正被改的是 `op4`。别在这几个类里空转。

---

### 3. 调用链假设(UI/功能 → 破解点)

```
[启动] SplashActivity.java:144-151
        └─ op4 单例 = f90.m(appCtx)  (f90.java:466-486 → new op4(Context) 命中 op4.java:67-75【patch A】)
        └─ if(!op4VarM.l()) op4VarM.n(false)  → 即使这条也因【patch B】写 is_ad_free=true

[广告闸门] u3.b(ctx): return !op4.v.m(ctx).l() && ...   (u3.java:32)
        └─ l()==true → !l()==false → 广告永不加载

[About 页] AboutActivity.java:49-55
        └─ if(op4.v.m(this).l()) 显示 "Ad Free" 徽章 + 按钮变 "Donate"; 否则 "Remove Ads"
        └─ l()==true → 永远走"已购买/去广告"分支

[菜单] gx0.d(Menu) (gx0.java:106-110): l()==true → item.setVisible(false) 隐藏 Remove Ads 入口
[测试列表] x22.N (x22.java:553-558,611): !l() 才插 "Ad" tile → l()==true 抑制广告位

[合法购买路径(mod 中冗余)] p62(真BillingClient) → oq1 回调 → op4.n(true)  (oq1.java:13-26)
```

**核心链**: 任意功能读 `op4.l()`(489) → 读 `kr1` StateFlow 的值 → 该值被构造器(72)播种 true 且被 n()(538)持续写 true。**单点恒真 → 全局 pro。**

---

### 4. 给 pi 的待验证清单(降级为"核对", 只读)

按顺序 Read 这几处, 确认即可结案(每条都给了期望看到的字面量):

- [ ] **VP1(主锚点)** Read `defpackage/op4.java:67-75` → 确认第71行 `sharedPreferences.getBoolean("is_ad_free", false);`(独立成句、返回值没被赋给任何变量=死读), 第72行 `kr1 kr1Var = new kr1(true);`(字面 true)。 ← **看到即锁定 patch A**
- [ ] **VP2(副锚点)** Read `defpackage/op4.java:529-539` → 确认第534行 `putBoolean("is_ad_free", true).putBoolean("billing_synced", true)`(是字面 true, 不是入参 z), 第538行 `kr1Var.e0(null, true)`。 ← **看到即锁定 patch B**
- [ ] **VP3(读取点)** Read `defpackage/op4.java:489-491` → 确认 `l()` 体是 `return ((Boolean)((kr1)this.s).c0()).booleanValue();`(this.s 即 72 行播种的 flow)。
- [ ] **VP4(恒真反证)** Read `defpackage/u3.java:14` → 确认同类型是 `new kr1(Boolean.FALSE)`, 对比证明 op4:72 的 true 是异常。
- [ ] **VP5(消费者印证任选1-2)** Read `defpackage/u3.java:32`(广告闸 `!op4.v.m(context).l() && ...`) 或 `com/ytheekshana/deviceinfo/AboutActivity.java:49`(pro UI 分支)。确认它们读的是 `op4...l()`。
- [ ] **VP6(排除法, 可选)** Read `defpackage/p62.java:107-109,148` → 确认这是真 BillingClient(有 GoogleBillingService/launchBillingFlow), **没被 stub** → 反证攻击点不在 billing 层。

---

### 诚实边界

- patch A / patch B / l() 三处已由我本人 Read 逐行复核, **file:line 精确、非推断**。
- "patched vs 原版"是**推断**(未 diff 干净原包), 依据是: 弃读的孤儿 `getBoolean`(71) + 忽略入参的 `n(z)` — 两条都是极强的 smali const-patch 指纹, 但严格说属推断。
- 未定位到独立的 Sensor/Export pro 闸门: grep SensorActivity/ExportActivity 无 op4/l() 引用。本版本 monetization 统一收敛到 `is_ad_free` 去广告权益, 无单独 sensor/export 门。**不编造该处 file:line。**
- 实际 banner 抑制的 AdView 加载点在 app 包内未找到(疑在混淆 defpackage/GMS ads glue, 观察 `op4.t = new ce1(kr1Var)` 只读流), **未 pin 到 file:line** — 但闸门布尔本身及其恒真赋值点已确凿, 不影响结论。
