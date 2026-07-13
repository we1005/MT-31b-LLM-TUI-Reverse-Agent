# Onboarding for Agents

给**其他 agent / 不同模型**快速接手本项目。仓库里有专门的对接文件夹 **`rev-agent/onboarding/`**，本页是它的导航摘要。

## 对接文件夹 `onboarding/`

| 文件 | 内容 |
|---|---|
| `README.md` | 项目定位 + 8 条铁律 + 30 秒跑起来 + 代码地图 + 资产在哪 + 当前状态&TODO + 怎么复现实验 |
| `TUI-输出代理与测试.md` | **agent = EventEmitter，前端只是订阅者** → "代理输出" = 订阅事件；四前端如何各自消费同一套事件；TUI 无头 `testRender`+`mockInput` 可程序化测试（含可跑代码 + 已知限制 + 踩过的坑） |
| `测试与数据格式.md` | 按模块测试计划（改 X→跑 Y）+ 数据格式（bank / SCORECARD / session.jsonl / ledger / 脱敏占位符 / case-file）+ 标准 A/B 复测顺序 |
| `资产索引.md` | `scripts/` `pi/` `docs-resources/` 记忆 全索引 + 环境路径速查 |

## 最快上手路径
1. 读 [[Iron Laws]]（别踩坑）。
2. 读 `onboarding/README.md`（全局）+ [[Quickstart]]（跑起来）。
3. 要改代码 → 看 `onboarding/README.md` 代码地图 + `onboarding/测试与数据格式.md` 的按模块测试计划。
4. 要复现实验 → `docs-resources/pi-agent实验复现手册.md`（含所有 verbatim 提示词）。
5. 要理解结论/别重复踩坑 → [[Experiments and Findings]] + `docs-resources/框架化-*.md`。

## 关键约定（重申）
- **lemonade 单并发** → 所有跑批串行，启动前 pgrep 确认无占用。
- **只读逆向合规** → 不产破解、不改 APK。
- **每次实验落 md → commit**（带 trailer）。
- **单跑 A/B 是噪声** → 多 seed 中位数 + 分题型 + 单变量。
- **中间产物不放 `/tmp`** → 放 `/Volumes/zhitai-7100/reverse-agent/_scratch/`（见 [[Roadmap]] / memory）。

## 跨会话记忆
`~/.claude/projects/-Volumes-zhitai-7100-reverse-agent/memory/`（`MEMORY.md` 是索引）。新会话首轮按其顺序读。
