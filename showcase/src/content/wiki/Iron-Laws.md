# Iron Laws（动手前必读）

违反这些会踩坑、卡后端、或越合规红线。

| # | 铁律 | 为什么 |
|---|---|---|
| 1 | **lemonade 单并发** —— 任何时刻只能有一个 agent 打后端；跑批**严格串行**，启动前 `pgrep -fl 'bun.*src/index.tsx\|coding-agent/dist/cli.js'` 确认无占用 | 并发会卡死后端 |
| 2 | **只用已加载的模型**（Qwen3.6），不触发切换/手动加载 | lemonade 10.x #2014 自动加载 bug；换模型需人在服务器侧操作 |
| 3 | **SWA 稳定前缀** —— 台账/动态内容**只拼 messages 末尾**，**绝不进 system 头部** | 进 system 每步破前缀缓存（实测 0% vs 97%）；治"越聊越卡" |
| 4 | **只读逆向合规** —— 不产出可用破解、不改 APK、不生成 patch/smali；apk 审计工具集限 `read,grep,find,ls`（物理排除 write） | 合规红线；产出=给原开发者的防御加固建议 |
| 5 | **每次实验/调研结果都沉淀成 md（含结论）再 commit+push** | 对话会压缩、后台结果会丢；只有落盘 md 是可跨会话复用/追溯的资产 |
| 6 | **单跑 A/B 是噪声** —— 本地 temp>0 双峰；对比必须**同题多 seed 取中位数 + 按题型分指标 + 单变量受控** | 一个漂亮/难看的单跑会误导决策（本项目实测踩过） |
| 7 | typecheck **baseline = 3 个错误**（SDK 类型不匹配，非新增），别为消它们改坏代码 | 已知基线 |

## 合规边界（详）

本项目是**防御性安全研究**：分析被违规破解（mod）的 App **是如何被绕过付费/授权校验的**，目的是给**原开发者**可落地的加固方案。

- ✅ 做：只读反编译产物、定位被改动的校验点（类.方法+行号）、说明手法、给加固建议（服务端校验 / 完整性签名 / 多点冗余 / 反 tamper）。
- ❌ 不做：产出可直接用的破解步骤 / patch / 重打包脚本；修改任何 APK；把定位当"破解教程"。
- 机制保障：`--once` 默认拒 write 类工具；apk 审计跑 pi 时用 `--tools read,grep,find,ls`（物理无 edit/write/bash）。

## 协作约定
- git 默认在 `main` 上改；除非明确要求才开分支。
- commit trailer：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 密钥（如 `.env` 里的 `ark-api-key`）只读入环境变量，**绝不 echo / 不入 git**。
