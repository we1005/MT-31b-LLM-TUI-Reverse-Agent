# Roadmap

## 已完成（框架化 MVP-0..4 已 FF 合入 main）

### 框架化：把逆向负担从模型移到框架
铁律：**框架只做两件事——① 按硬可观测事实注入 context ② 按资源硬上限收 budget；永不替 agent 决定"下一步/是否完成"**。越线即退化成反编译流水线。经**多 seed 消融定默认**（见 [[Experiments and Findings]] §3，`docs-resources/框架化-F1-F3-补证据-多seed.md`）：

- **F1 signal-gated 守卫（MVP-0/1/1.1）→ ✅ 默认开**（`REV_GUARD_MODE=count` 回退）：难题小胜、易题打平、~1.2× 速度代价。
- **F2 corpus 锚点自检（MVP-2）→ ✅ 合入**（仅 `--corpus` 模式）：负向 3/3 防错锚点传染 + 正向案卷 3/3、2.3× 快。
- **F3 playbook 栈感知注入 / MVP-4 自动生长 → ⚠️ 默认关**（opt-in `REV_PLAYBOOK=1`）：n=5+扩样本消融证 5 道 crack 题 playbook ON **一道都没更好**（OFF 胜2/平3/ON胜0）→ 默认净负，代码+自动生长保留备将来。
- 判分器 grouped-GT（多破解点）、结论检测 bug 修、离线测（136 断言）一并合入。
- ❌ 不做：通用**事实** RAG（弱模型检索悖论）；把 agent 写死成线性脚本；"检测 X 就强制执行 Y"式硬干预。

### 顺路发现缓存 → ❌ 阶段0 双否决，不合并（`findings-cache` 分支存档）
grep/读码顺路发现先留存复用。**阶段0 一票否决闸门已实测**（见 [[Experiments and Findings]] §6）：**Q1 痛点** FAIL（11 真实 run `folded=0` 从不折叠、ctx≪折叠阈 160k）+ **Q2 模型会用** FAIL（`--findings-cache` 开 6 run Qwen3.6 `notes_written=0` 一次没主动写）→ 与原调研预测一致，**不合入 main**。阶段1 MVP 代码（离线测 11/11）作"已验证证伪"制品留 `findings-cache` 分支。详见 `docs-resources/顺路发现缓存-{旁路语义记忆-深度分析,阶段0闸门-实测}.md`。

## 已标定的能力上限（现实）
- 全混淆无 grep 锚点的破解定位 = 本地 35B + keyword-grep 联合天花板。
- 破壁通道：强模型 case-file / 云端顾问（只"搬动"上限）/ 动态分析 frida（当前 harness 结构受限：shell 一次性、无 stdin）。

## 工程约定（新增规则）
- **本项目所有中间产物 / 临时文件 / 实验输出 / clone 的仓库（含本 wiki 仓库）一律放 `/Volumes/zhitai-7100/reverse-agent/_scratch/` 下，不放 `/tmp`。** 便于跨会话留存、避免临时目录被清。可按需在 `_scratch/` 下建子目录（`wiki/` `pi-bench/` 等）。
- git 默认 main；实验落 md；commit trailer 固定；lemonade 单并发串行。
