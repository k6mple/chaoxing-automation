# 环境与安装

## 目录与依赖

需要 Node.js 22+、本地 Chrome，以及允许访问学习通和已授权 AI 服务的网络。实际浏览器程序不随 Skill 分发；浏览器工具链使用锁定的 playwright-core，不自动下载浏览器。执行环境必须能启动或连接可视 Chrome，因此不能把本 Skill 当作纯云端无浏览器任务直接运行。

从任意固定工作目录调用绝对路径入口。先执行：

```powershell
node "<SKILL_DIR>/scripts/cx.js" doctor
npm ci --prefix "<SKILL_DIR>" --ignore-scripts --no-audit --no-fund
node "<SKILL_DIR>/scripts/cx.js" doctor
```

`doctor` 不启动浏览器，不访问课程或 AI，不输出密钥。缺 AI 密钥只给提示，仍可执行读取、显式答案和本地进度等命令。`doctor --connect` 额外只读探测指定 CDP，不建立任务页。

不要把程序中的 `<SKILL_DIR>` 原样执行；替换为加载本 Skill 的真实绝对目录。课程示例中的变量同理。

## 数据与登录

默认状态目录是**调用时当前目录**下的 `.chaoxing`，包括课程数据、账号登录 profile、控制文件和题目截图。Skill 目录只存程序和文档。

为了跨工作目录恢复同一任务，可显式设置：

```powershell
$env:CX_DATA = '<固定的数据目录绝对路径>'
$env:CX_CHROME = '<Chrome可执行文件绝对路径>' # 自动检测失败时
node "<SKILL_DIR>/scripts/cx.js" login $courseUrl
```

登录时用户在 Chrome 完成验证，脚本等待并且不刷新二维码。需要自行启动浏览器时使用独立 profile；指定端口已有 CDP 实例时会连接既有实例，必须核对实际账号上下文，不能仅凭配置的profile路径判断已切换账号。没有复制旧账号状态。复用旧状态时，显式将 `CX_DATA` 指向用户指定的旧数据目录，或用 `CX_PROFILE` 指向旧 profile。不可同时运行旧项目脚本与本 Skill 抢占同一个浏览器。

`CX_CDP` 可指定现有 HTTP CDP 地址，指定后连接失败不会另启浏览器。默认 CDP 端口9222，默认 profile 为 `<DATA_DIR>/chrome-profile`。

## AI 设置

默认文本服务为 `https://api.deepseek.com`，模型 `deepseek-chat`；默认视觉模型 `deepseek-flash`。模型、端点与可用性取决于实际服务，doctor 只检查配置，不做付费请求。

用环境变量 `DEEPSEEK_API_KEY`，或设置 `CX_CREDENTIALS` 指向用户自己的凭据文件。未指定时只读取 `<DATA_DIR>/credentials.yaml`。文件格式：

```yaml
DEEPSEEK_API_KEY: "用户自己的密钥"
```

避免在对话或终端命令输出中暴露密钥，不从其他项目或个人目录自动收集凭据。AI会接收题目文字或局部PNG；只在用户授权的范围和服务中启用。不同识图服务必须单独配置 `CX_VISION_API_KEY`，不会转发文本密钥到另一服务。

| 变量 | 用途 |
|---|---|
| CX_DATA | 固定运行数据根目录 |
| CX_PROFILE / CX_CHROME | 浏览器登录目录与程序路径 |
| CX_PORT / CX_CDP | 自动启动端口或现有CDP地址 |
| CX_PLAYWRIGHT | 显式使用外部 playwright-core 路径；默认只使用 Skill 自身依赖 |
| DEEPSEEK_API_KEY / CX_CREDENTIALS | 密钥或凭据文件 |
| CX_API_BASE / CX_MODEL | 文本接口与模型 |
| CX_VISION_API_BASE / CX_VISION_MODEL / CX_VISION_API_KEY | 视觉服务与独立密钥 |
| CX_TIMEOUT_MS / CX_VISION_TIMEOUT_MS | 页面/文本AI和视觉AI超时 |
| CX_LOGIN_TIMEOUT_MS | 等待人工登录，默认120秒 |
| CX_RATE / CX_INTERVAL_MS | 默认倍速2（0.5–2），任务间隔8秒 |
| CX_TIMEZONE | 日志展示时区，默认Asia/Shanghai；落盘为UTC |

## 加载与分发

本文件夹本身就是 Skill，可在会话中明确指向其 `SKILL.md` 使用。要自动发现，可将完整文件夹复制到工作项目的 `.agents/skills/chaoxing-automation`，或用户使用的 Skill 目录，再按所在宿主的方式加载。不要仅复制 SKILL.md；执行脚本与参考文件均需保留。未安装依赖的新位置需执行一次 `npm ci --prefix "<新SKILL_DIR>" ...`。

本次交付仅创建工作区文件，没有自动修改全局 Skill 设置。格式与发现机制参考 [OpenAI 官方 Skill 文档](https://learn.chatgpt.com/docs/build-skills)。

维护者可用 Python 3 标准库执行 `python "<SKILL_DIR>/scripts/package.py"` 生成 `dist/chaoxing-automation.zip`。压缩包不包含 node_modules、账号数据或运行目录；解压后仍需安装锁定依赖。验证命令为 `npm test --prefix ...`、`npm run check --prefix ...`、`npm run test:browser --prefix ...`，浏览器测试仅使用独立无头Chrome与模拟请求。

执行引擎是发布时的独立副本，engine-manifest.json用于校验该版本的14个模块摘要。后续修改副本时，应记录修复并维护发布摘要，再跑回归；不要改成指向原项目文件的链接。
