# 学习通任务自动化 Skill

常规的自动化脚本使用起来比较繁琐，上手有门槛，这个Skill提供强大的工具给agent使用，从而实现学习通任务的自动化完成，让LLM自行决策

让 Agent 配合本地浏览器脚本，按指定课程和章节处理学习通 / 超星的视频任务、视频弹窗题与章节测验。

脚本负责页面操作、进度核验和有限重试；Agent 负责理解任务范围、观察运行结果、处理未知页面和补充答案。既可以作为完整 Skill 使用，也可以单独通过命令行运行。

## 功能

| 功能 | 当前支持 |
|---|---|
| 课程与任务扫描 | 读取章节、附件和平台完成状态，跳过已完成任务 |
| 视频播放 | 串行播放、逐视频拖拽探测、加速与失败回退 |
| 视频弹窗题 | 缓存答案、未知题 AI 作答、错答排除、判对后继续播放 |
| 章节测验 | 提取题目、生成答案、填答校验、预览或授权提交 |
| 加密字体与图片题 | 截取题目局部 PNG，识读后作答，缓存识读结果 |
| 批量作答 | 两轮独立批量采样，仅对分歧题复核 |
| 恢复与记录 | 保留任务状态、错答历史、截图、事件日志和执行报告 |
| Agent 辅助 | 本地进度查询、协作停止、写入单个视频题的人工复核答案 |

目前不支持自动完成独立考试、直播、讨论、PBL 互评，以及必做 PPT / PDF 的自动阅读。页面能被扫描到，不代表该任务已实现自动处理。

## 运行环境

- Node.js 22 或更高版本，以及 npm。
- 本地 Chrome，或可连接的 Chrome CDP 实例。
- 能运行本地脚本、读取文件的 Agent；仅用命令行时不需要 Agent。
- 使用自动答题时，需要可用的 AI 接口和密钥；加密字体、图片题还需要视觉模型。

浏览器由本机提供。项目使用 `playwright-core`，安装依赖不会自动下载 Chrome。当前使用和实测以 Windows 为主；配置包含 macOS / Linux 的浏览器查找逻辑，仍需在相应环境验证。

## 快速开始

以下使用 Windows PowerShell。下载仓库后，进入**同时包含 `SKILL.md` 和 `package.json` 的目录**；如果下载的是完整工具箱仓库，该目录为其中的 `chaoxing-automation`。

```powershell
git clone https://github.com/k6mple/chaoxing-automation.git
cd chaoxing-automation
```

### 1. 安装与检查

```powershell
$skillDir = (Get-Location).Path
npm ci --ignore-scripts --no-audit --no-fund

# 将账号状态和运行数据固定放在仓库之外
$env:CX_DATA = Join-Path $env:LOCALAPPDATA 'chaoxing-automation'
node "$skillDir/scripts/cx.js" doctor
```

`doctor` 检查 Node.js、依赖、浏览器和密钥配置，不启动浏览器，不访问课程，也不发起 AI 请求。缺少 AI 密钥不影响读取状态、使用显式答案或查询本地进度。

自动找不到 Chrome 时，先设置路径，再执行检查：

```powershell
$env:CX_CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node "$skillDir/scripts/cx.js" doctor
```

### 2. 配置 AI

在 `$env:CX_DATA` 指向的目录创建 `credentials.yaml`，内容如下；将占位文字替换为自己的密钥：

```yaml
DEEPSEEK_API_KEY: "替换为自己的 API Key"
```

也可以通过环境变量 `DEEPSEEK_API_KEY` 提供密钥，或用 `CX_CREDENTIALS` 指向已有凭据文件。程序不自动加载 `.env` 文件。

默认文本接口为 `https://api.deepseek.com`，文本模型为 `deepseek-chat`，视觉模型为 `deepseek-flash`。可以通过环境变量更换端点和模型，具体配置见 [环境与安装](references/setup.md)。接口需支持程序使用的 Chat Completions 格式，视觉接口还需支持图片输入；实际模型权限与可用性取决于服务账号。`doctor` 只检查配置，不验证付费接口是否可调用。

AI 请求会发送题目文字，以及需要识图时的题目局部截图。Agent 应在用户授权的服务和题目范围内使用；AI 服务可能产生费用。不同视觉服务需单独配置 `CX_VISION_API_KEY`。

### 3. 登录并确认章节

```powershell
# 使用浏览器地址栏中的完整课程链接；保留引号
$courseUrl = '在这里粘贴完整课程链接'
node "$skillDir/scripts/cx.js" login $courseUrl
node "$skillDir/scripts/cx.js" list $courseUrl
```

在打开的 Chrome 中完成登录。后续复用相同的数据目录即可保留登录状态；登录过期或出现验证码时，需要用户在浏览器中处理。

从 `list` 输出选择真实章节 ID。章节标题中的“5.13”不是程序使用的章节 ID。

### 4. 交给 Agent 执行

将**整个 Skill 文件夹**放入 Agent 宿主支持的 Skill 目录，或在会话中明确提供本地 `SKILL.md` 的路径，让 Agent 读取后执行。安装路径和重新加载方式由所用宿主决定。

示例请求：

> 使用 $chaoxing-automation 处理这门课程的第五章。允许将该章题目文字和必要局部截图发送到我配置的 DeepSeek 服务。先完成视频，章节测验填好后停在预览页面。记录耗时和失败项。课程链接：……

需要正式提交时，在请求中明确说明课程、章节和提交范围。已有会话授权仍适用时，Agent 会沿用授权。未授权提交的测验默认只填答预览。

## 直接使用命令行

沿用上面的 `$skillDir`、`$courseUrl` 和固定 `CX_DATA`。将占位章节 ID 替换为 `list` 返回的数字。

```powershell
$chapterId = '替换为真实章节ID'

# 仅处理该章节视频；未知弹窗默认使用已配置的 AI
node "$skillDir/scripts/cx.js" video $courseUrl $chapterId --accelerate --rate 2

# 视频与测验顺序运行；测验仅填答预览
node "$skillDir/scripts/cx.js" run $courseUrl $chapterId --accelerate --rate 2 --ai

# 需要正式提交时，在上面的 run 命令中添加 --submit

# 只运行测验，填好后预览
node "$skillDir/scripts/cx.js" solve $courseUrl $chapterId --ai

# 查询本地进度，或请求停止当前执行
node "$skillDir/scripts/cx.js" progress $courseUrl
node "$skillDir/scripts/cx.js" stop
```

视频未知题默认启用 AI，可用 `--no-ai` 关闭；测验自动答题需显式添加 `--ai`。不使用第三方 AI 时，也可让 Agent 读取本地题目或截图，再通过 `--answers` 提供测验答案，或通过 `remember` 补充视频题答案。

`stop` 是协作停止请求。收到 `stop-requested` 后，继续检查原进程输出或 `progress`，确认进程已停止，再启动下一轮。不要同时运行多个命令操作同一个浏览器。

完整参数、答案文件格式和恢复操作见 [命令与答案](references/commands.md) 与 [Agent 运行与恢复](references/recovery.md)。

## 视频速度与完成判定

Skill 指导 Agent 默认使用 `--accelerate --rate 2`，按以下顺序处理每个未完成视频：

1. 先处理当前弹窗和已记录的待答题。
2. 在暂停状态尝试跳到视频 90%，等待约 1.7 秒观察是否回弹。
3. 拖拽通过后，保留该位置，启用影子 16 倍速播放剩余部分。本策略最高使用 16 倍。
4. 拖拽被拦、时长不可用或加速未完成时，重新打开视频，尝试从头以 2 倍速兜底。2 倍仍未通过且真实心跳明确未通过时，最多再尝试一次 1 倍恢复。

影子模式通过媒体原生属性设置实际 16 倍速，同时让播放器读取到的实例属性值为 1；日志分别记录真实 `rate` 与 `reportedRate`。结束、失败或停止时会暂停视频并清理该属性。

每个视频独立探测，前一个视频失败不会取消下一个视频的探测。原始命令不带 `--accelerate` 时仍按普通速度播放；Agent 需要主动添加参数。`--accelerate --no-seek` 仅用于明确要求跳过拖拽探测、只用 16 倍速的场景。

**完成以平台真实任务标记为准。** 跳到 90%、播放结束或本地记录为成功，都不能单独证明平台已通过。平台确认完成且没有当前弹窗或待答题时，脚本立即暂停并进入下一任务。加速可能越过尚未出现的弹窗，因此不能据此声称回答了视频中的全部题目。

## 答题与截图识读

测验默认采用两轮独立批量作答：将一组题目分别请求两次，先接受一致答案，仅对存在分歧的题目追加复核。格式错误、缺失答案或复核后仍无法确定的题目会保留为未解决，不以猜测补齐提交。

遇到加密字体或图片题，程序使用 **Playwright `Locator.screenshot()`**，由 Chrome 渲染并截取题目区域 PNG，再交给视觉模型识读。识读结果按图片、模型和接口缓存，填答时仍核验原页面题目与选项，避免识读后的文字错位。

视频弹窗优先复用已有答案；未知题调用 AI。平台判错后保留错选组合并排除该组合，有限重试；平台判对后才把答案记为已验证。AI 两轮一致不代表答案必然正确。

## 数据与隐私

未设置 `CX_DATA` 时，数据默认保存在**运行命令时所在目录**的 `.chaoxing` 中。更换工作目录可能导致使用另一份状态，建议始终固定 `CX_DATA`。

```text
<CX_DATA>/
├── credentials.yaml             本地 AI 凭据（自行创建）
├── chrome-profile/              浏览器登录状态
├── control/                     进程状态与停止请求
└── runtime/<课程身份>/
    ├── events.jsonl             执行事件
    ├── run-report.json          最近一轮报告
    ├── tasks.json               任务与恢复状态
    ├── jobs.json                最近扫描的线上附件状态
    ├── video-memory.json        视频答案与错答历史
    └── …                       题目、截图、答题计划和核验结果
```

课程链接、浏览器 profile、凭据、题目截图和日志可能包含个人信息，应保留在本地。提交 Issue 时请删去密钥、Cookie、课程签名和个人信息。分发脚本只打包指定的源文件目录，不包含运行数据与 `node_modules`。

结果字段含义、报告覆盖范围及已有实测边界见 [结果契约与验证边界](references/results.md)。本地 `progress` 用于观察过程，最终完成情况仍需线上核验。

## 开发与验证

在 Skill 根目录执行：

```powershell
npm test
npm run check
npm run test:browser
```

- `npm test`：当前共 55 项测试，覆盖答案校验、批量复核、恢复、停止和独立运行等行为。
- `npm run check`：检查 JavaScript 语法、引擎文件摘要和参考文档链接。
- `npm run test:browser`：使用独立无头 Chrome、本地页面和短视频，验证真实浏览器交互，不登录真实课程、不向平台提交。

已有真实课程测试覆盖视频播放、弹窗恢复、加密题识读与测验提交；最新的“先探测拖拽，再 16 倍，失败回退 2 倍”修订通过离线浏览器验证，尚未进行该修订的真实课程回归。不同课程配置、页面版本和 AI 输出可能影响结果。

源码包可通过 Python 3 标准库生成：

```powershell
python scripts/package.py
```

输出为 `dist/chaoxing-automation.zip`。解压到新位置后，需要重新安装锁定依赖。

## 目录结构

```text
chaoxing-automation/
├── README.md                    项目介绍与使用入口
├── LICENSE                      MIT 许可证
├── SKILL.md                     Agent 执行指引
├── agents/openai.yaml           Skill 展示元数据
├── references/                  环境、命令、恢复和结果说明
├── scripts/
│   ├── cx.js                    统一命令入口
│   ├── control.js               执行状态与协作停止
│   ├── doctor.js                环境检查
│   ├── remember.js              Agent 补充视频题答案
│   ├── package.py               源码分发打包
│   └── toolkit/                 独立执行引擎与回归测试
├── test/                        Skill 封装测试
├── engine-manifest.json         执行引擎文件摘要
└── WORK_PLAN.md                 开发计划与验证记录
```

反馈问题时，请提供版本、操作系统、Node.js / Chrome 版本、执行命令、预期与实际结果，以及脱敏后的相关事件。修改执行引擎时需同步 `engine-manifest.json`，并运行与改动相关的检查。

## 许可证

本项目采用 [MIT 许可证](LICENSE)，允许使用、修改、商用和再分发，要求保留版权与许可声明；软件按原样提供，不提供担保。版权署名为 `chaoxing-automation contributors`。

第三方依赖仍遵循各自许可证，例如 `playwright-core` 使用 Apache-2.0；本项目许可证不替代依赖的许可条款。
