# pi/ — 用 pi-agent 驱动本地 Qwen3.6(lemonade) 的可复现产物

配合 `docs-resources/pi-agent接入Qwen3.6-计划.md`(计划) 与 `pi-agent接入Qwen3.6-实测对比.md`(实测结论)。

- `lemonade-provider.ts` — pi 自定义 provider 扩展(registerProvider 接 lemonade OpenAI 兼容端点, thinkingFormat=qwen-chat-template)。放 pi 仓库根或 `.pi/extensions/`，或 `pi -e ./lemonade-provider.ts`。
- `re-discipline.txt` — RE 纪律系统提示(--append-system-prompt)。**实测：注入它是让本地模型在大反编译树上不超时的最关键设置。**
- `audit-sysprompt.txt` — apk-moded 只读防御审计系统提示(--system-prompt 整体替换)。
- `run-pi.sh` — 串行驱动 + 抓指标 runner(尊重 lemonade 单并发)。用法见脚本头。
- `GT-easynotes.md` — EasyNotes 破解 ground truth(人工核实, 判分用)。

pi 源码在本机 `/Volumes/zhitai-7100/pi-0.80.6/`(@earendil-works/pi-coding-agent v0.80.6)，需先 `npm ci --ignore-scripts && npm run build`。
