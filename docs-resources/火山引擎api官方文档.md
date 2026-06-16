本文介绍如何在编程工具中快速使用 Coding Plan 套餐所支持的模型进行代码开发。


<card mode="container" align="left" >

<span id="61e3b838"></span>
# 核心配置

接入工具的核心参数如下：

<span id="3a775131"></span>
## **模型配置**

支持以下两种方式配置模型：


<Tabs>
<Tab zoneid="zc5aiwaNVB" title="配置 Model Name (配置文件指定)">
<TabTitle>配置 Model Name (配置文件指定)</TabTitle>

在工具配置文件中指定 Model Name，可实时切换模型。支持配置的 Model Name：

<div data-tips="true" data-tips-type="warning" data-tips-is-title="true">注意</div>


<div data-tips="true" data-tips-type="warning">配置 Model Name 时，支持使用全小写格式，同时也支持直接复制<a href="https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=subscribe">开通管理页面</a>中的模型名称。</div>



* \`doubao-seed-2.0-code\`

* \`doubao-seed-2.0-pro\`

* \`doubao-seed-2.0-lite\`

* \`doubao-seed-code\`

* \`minimax-m2.7\`

* \`minimax-m3\`

* \`glm-5.1\`

* \`deepseek-v4-flash\`

* \`deepseek-v4-pro\`

* \`kimi-k2.6\`


<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">说明</div>


<div data-tips="true" data-tips-type="tip">Model Name 不支持配置为 <code>Auto</code>，如需使用，请通过控制台切换该模式。</div>



</Tab>
<Tab zoneid="SQEO49DIbD" title="配置 ark-code-latest (控制台管理)">
<TabTitle>配置 ark-code-latest (控制台管理)</TabTitle>

1. 在配置文件中指定模型为\`ark-code-latest\`。

2. 通过[开通管理页面](https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=subscribe)选择或切换目标模型，切换模型后 3\\-5 分钟即可生效。

   支持 Auto 模式，通过「效果 + 速度」双维度智能算法自动选择模型。


</Tab>
</Tabs>


<span id="7fd1eee7"></span>
## **Base URL**

不同的工具配置的 Base URL 根据兼容的协议会有不同：


* 兼容 Anthropic 接口协议工具：\`https://ark.cn-beijing.volces.com/api/coding\`

* 兼容 OpenAI 接口协议工具：\`https://ark.cn-beijing.volces.com/api/coding/v3\`


<div data-tips="true" data-tips-type="warning" data-tips-is-title="true">注意</div>


<div data-tips="true" data-tips-type="warning">请勿使用 <code>https://ark.cn-beijing.volces.com/api/v3</code> ：该 Base URL 不会消耗您的 Coding Plan 额度，而是会产生额外费用。</div>


<span id="f05bb565"></span>
## **API Key**

[获取 API Key](https://console.volcengine.com/ark/region:ark+cn-beijing/apikey)

</card>



<span id="a3758e4d"></span>
# 步骤一：订阅方舟 Coding Plan

访问[方舟 Coding Plan 活动](https://www.volcengine.com/activity/codingplan)，按需订阅套餐。套餐介绍请参见[套餐概览](https://www.volcengine.com/docs/82379/1925114)。

<span id="c5311898"></span>
# 步骤二：配置编程工具

Coding Plan 支持主流的编程工具，可按需选择。


<columns>
<columnsItem zoneid="FMYhy2pqfn">


<card mode="container" href="https://www.volcengine.com/docs/82379/1928262" iconsize="s" align="left" >

**Claude Code**

AI 终端编程助手，自然语言编程

</card>




<card mode="container" href="https://www.volcengine.com/docs/82379/2205646" iconsize="s" align="left" >

**TRAE**

智能 IDE，构建新一代编程工作流

</card>




<card mode="container" href="https://www.volcengine.com/docs/82379/2188959#e60a76e3" iconsize="s" align="left" >

**Roo Code**

轻量级编程助手

</card>




<card mode="container" href="https://www.volcengine.com/docs/82379/2188959#d89506ca" iconsize="s" align="left" >

**Codex CLI**

OpenAI 推出的命令行编程工具

</card>



</columnsItem>
<columnsItem zoneid="BGqTiWmZif">


<card mode="container" href="https://www.volcengine.com/docs/82379/2188958" iconsize="s" align="left" >

**OpenCode**

开源 AI 编程代理工具

</card>




<card mode="container" href="https://www.volcengine.com/docs/82379/2188959#2baed520" iconsize="s" align="left" >

**Cline**

VSCode 扩展，代码补全和调试

</card>




<card mode="container" href="https://www.volcengine.com/docs/82379/2188959#8acf9b21" iconsize="s" align="left" >

**Kilo Code**

轻量高性能编程工具

</card>



</columnsItem>
<columnsItem zoneid="R5AsjexqZZ">


<card mode="container" href="https://www.volcengine.com/docs/82379/2183190" iconsize="s" align="left" >

**OpenClaw**

开源、自托管个人 AI 助手

</card>




<card mode="container" href="https://www.volcengine.com/docs/82379/2188959#6974ab2b" iconsize="s" align="left" >

**Cursor**

AI 原生代码编辑器

</card>




<card mode="container" href="https://www.volcengine.com/docs/82379/2318283" iconsize="s" align="left" >

**Hermes Agent**

开源自主 AI 智能体

</card>



</columnsItem>
</columns>


下面以 Claude Code 为例介绍如何使用 Coding Plan。

<span id="037e332e"></span>
## 安装 Claude Code

前提条件：


* 安装 [Node.js 18 或更新版本环境](https://nodejs.org/en/download/)。

* Windows 用户需安装 [Git for Windows](https://git-scm.com/download/win)。


在命令行界面，执行以下命令安装 Claude Code。

```Bash
npm install -g @anthropic-ai/claude-code
```


安装结束后，执行以下命令查看安装结果，若显示版本号则安装成功。

```Bash
claude --version
```


<span id="2bfb05a3"></span>
## 配置工具

<span id="3487df77"></span>
### 方式一：自动化助手（推荐）

Ark Helper 是一个编码工具助手，支持快速配置选择的工具接入 Coding Plan。安装并运行该助手，根据界面提示操作可自动完成工具配置，降低手动配置的时间成本和出错风险。

<div data-tips="true" data-tips-type="warning" data-tips-is-title="true">注意</div>



* <div data-tips="true" data-tips-type="warning">Ark Helper 仅支持 MacOS、Linux 系统，暂不支持 Windows 系统。</div>


* <div data-tips="true" data-tips-type="warning">以下配置步骤及截图为 Ark Helper 首次使用指引；非首次使用请按界面提示完成套餐配置和工具配置。</div>


1. 执行以下命令安装 Ark Helper。

   ```Bash
   curl -fsSL https://lf3-static.bytednsdoc.com/obj/eden-cn/ylwslo-yrh/ljhwZthlaukjlkulzlp/install.sh | sh
   ```
   

   安装完成后，执行以下命令查看安装的版本号。

   ```Bash
   ark-helper --version
   ```
   
2. 在命令行界面输入`ark-helper`命令，启动 Ark Helper。

   <span>![图片](https://p9-arcosite.byteimg.com/tos-cn-i-goo7wpa0wc/802e66e79f864ceeaba2d05250f1c743~tplv-goo7wpa0wc-image.image) </span>

3. 根据界面提示完成套餐配置。

   1. 选择要配置的套餐：`[Volcano] Volcano Engine（国内）`。

   <span>![图片](https://p9-arcosite.byteimg.com/tos-cn-i-goo7wpa0wc/6a68961ee782408ca485dff07b2fcfb5~tplv-goo7wpa0wc-image.image) </span>

   2. 配置 API Key： [获取 API Key](https://console.volcengine.com/ark/region:ark+cn-beijing/apikey)。

   <span>![图片](https://p9-arcosite.byteimg.com/tos-cn-i-goo7wpa0wc/0f327801346548e49580aff3fbfe9c0f~tplv-goo7wpa0wc-image.image) </span> <span>![图片](https://p9-arcosite.byteimg.com/tos-cn-i-goo7wpa0wc/0d49b2af47294daba8a5e2c86f2c706c~tplv-goo7wpa0wc-image.image) </span>

   3. 选择默认模型。

   <span>![图片](https://p9-arcosite.byteimg.com/tos-cn-i-goo7wpa0wc/a9a13add5808465bb8c27d6518623916~tplv-goo7wpa0wc-image.image) </span>

4. 根据界面提示完成 Claude Code 工具配置。

   1. 选择要配置的编码工具：`Claude Code`。

   <span>![图片](https://p9-arcosite.byteimg.com/tos-cn-i-goo7wpa0wc/265d432ab0a549c38eacb7be53891a8a~tplv-goo7wpa0wc-image.image) </span>

   2. 选择`设置 Volcano 配置到 Claude Code`，配置完成后，选择`退出`。如果需要重新配置工具，可先选择`卸载 Claude Code 配置`，再重新执行配置流程。

   <span>![图片](https://p9-arcosite.byteimg.com/tos-cn-i-goo7wpa0wc/b00e2ee6cb444876b2ff705dac04a7e0~tplv-goo7wpa0wc-image.image) </span>


<span id="561a3715"></span>
### 方式二：手动配置

完成Claude Code安装后，配置以下信息。


* **ANTHROPIC_BASE_URL**：`https://ark.cn-beijing.volces.com/api/coding`

* **ANTHROPIC_AUTH_TOKEN**：[获取 API Key](https://console.volcengine.com/ark/region:ark+cn-beijing/apikey)

* **ANTHROPIC_MODEL**: 支持配置 Model Name （实时切换模型）、配置`ark-code-latest`（控制台切换模型）两种方式，具体见[模型配置](https://www.volcengine.com/docs/82379/1928261#ngCxjYAzHr)。


配置步骤如下：


1. 创建并打开 `settings.json` 配置文件。文件路径因系统而异，具体操作如下：

   
   <Tabs>
   <Tab zoneid="YpqhPFukho" title="macOS/Linux">
   <TabTitle>macOS/Linux</TabTitle>
   
   macOS/Linux 系统 Claude Code 配置文件路径：`~/.claude/settings.json`。
   
   
      1. 如果在主目录下没有`.claude`目录，执行以下命令创建目录。
   
         ```Bash
         mkdir -p ~/.claude
         ```
         
      2. 创建并打开配置文件。
   
         ```Bash
         nano ~/.claude/settings.json
         ```
         
   
   
   </Tab>
   <Tab zoneid="fQH424xM7X" title="Windows">
   <TabTitle>Windows</TabTitle>
   
   Windows 系统 Claude Code 配置文件路径：`C:\Users\<用户名>\.claude\settings.json`。以 CMD 命令行方式为例，操作如下。
   
   
      1. 如果当前用户目录下没有`.claude`目录，执行以下命令创建目录。
   
         ```Bash
         if not exist "%USERPROFILE%\.claude" mkdir "%USERPROFILE%\.claude"
         ```
         
      2. 创建并打开配置文件。
   
         ```Bash
         notepad "%USERPROFILE%\.claude\settings.json"
         ```
         
   
   
   </Tab>
   </Tabs>
   
2. 编辑配置文件，需要修改的配置信息如下：

   * `<ARK_API_KEY>`：替换为您自己的 [API Key](https://console.volcengine.com/ark/region:ark+cn-beijing/apikey)。

   * `<Model_Name>`：更新为需要使用的模型信息，如`ark-code-latest`。支持的模型信息参见[模型配置](https://www.volcengine.com/docs/82379/1928261#ngCxjYAzHr)。

   ```JSON
   {
       "env": {
           "ANTHROPIC_AUTH_TOKEN": "<ARK_API_KEY>",
           "ANTHROPIC_BASE_URL": "https://ark.cn-beijing.volces.com/api/coding",
           "ANTHROPIC_MODEL": "<MODEL_NAME>",
           "ANTHROPIC_DEFAULT_HAIKU_MODEL": "<MODEL_NAME>",
           "ANTHROPIC_DEFAULT_SONNET_MODEL": "<MODEL_NAME>",
           "ANTHROPIC_DEFAULT_OPUS_MODEL": "<MODEL_NAME>",
           "CLAUDE_CODE_SUBAGENT_MODEL": "<MODEL_NAME>"
       }
   }
   ```
   

   <div data-tips="true" data-tips-type="tip" data-tips-is-title="true" data-wrapper-indent="1">说明   </div>
   

   <div data-tips="true" data-tips-type="tip" data-wrapper-indent="1">推荐使用完整模型配置，显式指定 Haiku、Sonnet、Opus 及子 Agent 模型，实现不同复杂度任务的模型调度。   </div>
   
3. 编辑或新增 `.claude.json` 文件，修改或新增 `hasCompletedOnboarding` 字段值为 true。

   1. 不同系统`.claude.json`配置文件路径如下：

      * macOS/Linux：`~/.claude.json`

      * Windows：`C:\Users\<用户名>\.claude.json`

   2. 修改或新增的字段信息如下：

      ```JSON
      {
        "hasCompletedOnboarding": true
      }
      ```
      


保存配置文件后，在新的终端窗口执行后续命令。

<span id="a351e130"></span>
## 使用 Claude Code


1. 启动 Claude Code：进入项目目录，执行`claude`命令，即可开始使用 Claude Code。

   ```Bash
   cd my-project
   claude
   ```
   

   启动后，选择信任此文件夹，允许 Claude Code 访问该文件夹中的文件。

2. 模型状态验证：输入`/status`确认模型状态。


<span>![图片](https://p9-arcosite.byteimg.com/tos-cn-i-goo7wpa0wc/4382021492134eee946601bf53514b48~tplv-goo7wpa0wc-image.image) </span>


3. 在 Claude Code 中对话。


<div data-tips="true" data-tips-type="warning" data-tips-is-title="true">注意</div>


<div data-tips="true" data-tips-type="warning"><a href="https://www.volcengine.com/docs/82379/2165245#1c6446b6">Claude Code 如何开启深度思考模式？</a></div>


<span>![图片](https://p9-arcosite.byteimg.com/tos-cn-i-goo7wpa0wc/631742d8a5814d68a5cbc62988ba8cab~tplv-goo7wpa0wc-image.image) </span>

<span id="f2fb050d"></span>
## 切换模型

请根据模型配置方式，选择对应的模型切换方案。


<span aceTableMode="list" aceTableWidth="1,3,3"></span>
| 配置方式     | 配置`ark-code-latest`                                        | 配置 Model Name                                              |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 切换模型操作 | 1. 在[开通管理页面](https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=subscribe)选择要使用的模型，切换后3\-5分钟即可生效。<br><br>2. 在命令行窗口，启动 Claude Code 后，输入`/status`确认模型状态。 | * 启动时：执行`claude --model <Model_Name>`，可指定对应的模型。<br><br>* 对话期间：执行`/model <Model_Name>`切换模型。 |


<span id="98f1b16e"></span>
# 常见问题

[常见问题](https://www.volcengine.com/docs/82379/2165245)

<span id="904b34ad"></span>
# 错误码

如遇报错，可根据错误信息查看错误码说明，定位&解决问题。详细信息请参见[错误码](https://www.volcengine.com/docs/82379/1299023)。