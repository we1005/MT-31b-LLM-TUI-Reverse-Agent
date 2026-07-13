# Experiments and Findings

实测沉淀（都有对应 `docs-resources/*.md` 详版）。原则：**诚实第一**——单跑会骗人，凡结论标注证据强度。

## 1. pi-agent × 本地 Qwen3.6 基准（能力标定）

把本地模型接进通用 coding agent [pi](https://github.com/earendil-works/pi)（自定义 provider 扩展，不改 pi 源码；`reasoning_content` 经 pi-ai 原生解析）。驱动方式 = 无头 `pi -p`（**非 TUI 对话**）。同题同模型对比 rev-agent：

| 任务类型 | pi（最佳设置） | rev-agent |
|---|---|---|
| 中难度定点定位（mt-jadx MCP 入口） | ✅ 命中全部 GT（更慢） | ✅ 更快更省（协议+台账焊死） |
| 高难度有锚点深多跳（EasyNotes 破解审计） | ✅ 精确命中真破解点 | ⚠️ 视 seed 而定（见下多 seed 修正） |
| 高难度无锚点全混淆（Device_Info） | ❌ 超时空答（无 grep 锚点） | ❌ 同上（模型上限） |

**关键设置（本地模型 + pi 的最佳配置）**：
- **注入 RE 纪律系统提示是决定性设置**——pi 默认 coding 提示在大反编译树上必超时；注入"grep 先行 / ≤200 行 read / 拿到 file:line 就收尾"后翻转成功。
- `thinkingFormat: qwen-chat-template`（本地 llama.cpp 正确格式）；apk 审计 `--tools read,grep,find,ls`（只读）；`--mode json` 抓指标；串行。

详见 `docs-resources/pi-agent接入Qwen3.6-实测对比.md` + `pi-agent实验复现手册.md`。

## 2. ⭐ 前置强模型案卷 → 弱模型续跑（突破单跑上限）

pi 单跑打不动的全混淆题（Device_Info），用**强模型先做前置分析产 case-file**（去混淆映射 + 候选破解点 `file:line` + 待核对清单）喂给 pi 续跑：

| Device_Info | pi 单跑 | **pi + 案卷** |
|---|---|---|
| 结果 | ❌ 900s 超时空答 | ✅ 132s 正确四段式审计 |
| 工具 | 47（30 grep 乱搜） | 14（**全 read，0 grep**） |

机制：案卷把"在无锚点混淆树里搜索"（弱模型死穴）**降级成"照 file:line 核对"**（弱模型强项）。这是"强模型定位 + 弱模型核对落地"的分工，也是 rev-agent `--corpus` 模式；云端顾问可作在线的前置强模型来源。

## 3. 框架化 MVP-0..4（已合入 main，多 seed 定默认）

把"决策/流程/记忆"负担从弱模型移进框架，**逐特性多 seed 消融定 main 默认**（`docs-resources/框架化-F1-F3-补证据-多seed.md` + `框架化-feature复盘.md`）：

| 特性 | 默认 | 多 seed 证据 |
|---|---|---|
| **F1 signal-gated 守卫** | ✅ 默认开（`REV_GUARD_MODE=count` 回退） | n=5：难题 q02 signal 小胜（中位 0.57/gt 3-of-5 vs count 0.43/2-of-5）、易题打平、~1.2× 速度代价 |
| **F2 corpus 锚点自检** | ✅ 合入（仅 `--corpus`） | n=3：负向 3/3 防错锚点传染 + 正向案卷 3/3、2.3× 快、更深 |
| **F3 playbook 注入 / MVP-4 自动生长** | ⚠️ 默认关（`REV_PLAYBOOK=1`） | n=5+扩样本：5 道 crack 题 playbook ON **一道都没更好**（OFF 胜2/平3/ON胜0）→ 默认净负 |

> **教训（"单跑会骗人"的活教材，两连击）**：① 守卫软化最初一次漂亮单跑差点让结论过头，多 seed 拉回诚实。② **F3 playbook 更狠——n=3 曾把它从"准备砍"翻成"保留(谨慎乐观)"，n=5+扩样本又翻回"不当默认"。铁律：别凭 n=3 定 main 默认。** 离线守卫测 signal16/guards33/corpus9/playbook17/scorer6 全过。

## 3b. 10 题能力测试闭环（找 bug→修→再跑对比）

10 题建 bank → 跑 rev-agent（全框架开）→ 诊断失败 → 修可修的 → 再跑对比。平均锚点召回 **0.311**（`docs-resources/框架化-能力测试闭环-10题.md`）。

- **分层清晰**：静态定位满分（q01=1.00）、常规命名破解题良好（q02=0.86/q06=0.67）；深协程链 / 短名混淆 / 大体量多破解点召回坍塌。
- **归因铁律**：5 个 miss 里只 1 个（q09 playbook 锚点缺口）框架可修（修后 surface 对锚点但**收敛不了大体量 App=有效但不充分**），其余是模型上限或判分局限——**别把模型上限伪装成待修 bug**。
- **判分器自我 red-team**：曾以为 q08-clone 是"多破解点判分假阴"，对抗式验证（全树 grep 零调用）推翻——agent 找的 `leetrue()` 是**死代码**，0.00 是真 miss。**连提 fix 者自己的前提都要被验证**（`docs-resources/框架化-判分器-多GT改进.md`）。

## 6. 顺路发现缓存 → 阶段0 闸门双否决（证伪，不合并）

"顺路发现先留存复用"的想法，**阶段0 一票否决闸门实测证伪**（`docs-resources/顺路发现缓存-阶段0闸门-实测.md`，分支 `findings-cache`）：

| 闸门条件 | 结果 | 证据 |
|---|---|---|
| Q1 痛点真实吗 | ❌ FAIL | 11 真实 run `folded=0`（从不折叠），`max_ctx` 5k–28k ≪ 折叠阈 160k → 没被折叠出去的内容可复原 |
| Q2 小模型真会用吗 | ❌ FAIL | `--findings-cache` 开 + un-gate + auto-approve，6 run Qwen3.6 **一次 `append_note` 都没主动写**（`notes_written=0`）→ 缓存永远空 |

→ 双否决，**不合入 main**；MVP 代码（离线测 11/11、flag 关零变化）作"已验证证伪"制品留分支。这是"阶段0 闸门=以证伪为目标"设计兑现的干净案例：**低成本先写好、放着，但没被证明有用就不合**。

## 4. 脱敏云端顾问（混合后端，已交付）

本地卡住 → 困境报告**脱敏**（台账已知标识符精确替换 + 正则兜底 + fail-closed 泄露扫描）→ 问云端拿**方法论**（占位符级）→ 还原回本地续跑。默认关（`--consult-cloud`）。真实外部云（火山引擎/minimax）live 验证：出网 payload 0 泄露、云端思路还原后可用。详见 `docs-resources/混合后端-云端顾问-交付与验证.md`。

## 5. 能力上限（如实）
- **全混淆无 grep 锚点的破解定位** = 本地 35B + keyword-grep 的**联合天花板**，两套 harness 单跑都打不动。
- 破壁靠：**强模型 case-file**（§2，只"搬动"上限）/ 云端顾问（§4）/ 动态分析（frida，但当前 harness 结构受限）。
- 结论：**决定成败的杠杆更多在"行为/流程编码 + 强模型前置"，而非本地模型自身知识**（见 `docs-resources/框架化-把逆向负担从模型移到框架.md`）。
