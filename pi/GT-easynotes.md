# EasyNotes VIP mod — 破解 ground truth (主控人工核实)
- 破解点: UserConfig.getHasBuyed() @ constant/UserConfig.java:1052-1054 与 getHasSubscribe() @ :1158-1160
- 手法: 两个 getter 被 patch 成无条件 `return true`(仍调 prefs.getBoolean(...) 但丢弃结果), 原版返回真实 SharedPreferences 标志
- 调用链: 功能点/UI → App.isVip() @ App.java:269 → line 277 `if (userConfig.getHasBuyed() || userConfig.getHasSubscribe())` → 被 patch 的两个 getter 恒真 → VIP 解锁
- 加固: 服务端 entitlement 校验 / 不信本地 pref bool / 完整性+签名校验 / 多点冗余校验 / 混淆强化
- 判分锚点: getHasBuyed getHasSubscribe UserConfig App.isVip return true
