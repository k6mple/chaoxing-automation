# Agent运行与恢复

## 观察和改变范围

长任务使用执行工具提供的运行会话，不要在工具超时后假定脚本已停止。每30–60秒左右读取新输出或 `progress`，避免高频抢页面。当前播放、弹窗、耗时与异常会写入 events.jsonl / tasks.json。

用户改变“做到哪里”时先判断旧队列是否仍会进入范围外任务。需要改变队列则：

1. 同一工作目录/CX_DATA执行 `stop`。
2. 读取原进程输出或 `progress`，确认 `active.alive=false` 且生命周期为 stopped/completed。
3. 仅启动新指定的章节ID队列。网站可能恢复到较早检查点，记录回退，不拖动进度补偿。

stop会写入带运行令牌的请求，由原进程调用现有AbortController。视频循环和AI请求支持取消；导航/人工登录等待或部分测验AI等待可能要到下一次检查才停止。不要仅看到stop-requested就启动第二个任务。仍在stopping时先查看原进程输出，不能声称已停。进程被工具强杀时可能显示crashed，先确认没有遗留视频播放，再重跑；不要直接删除活动进程的锁。

## 常见事件

| 状态/事件 | Agent处理 |
|---|---|
| PLAYING | 时间前进就继续；在平台通过前不按百分比判完成 |
| PREPARE_POPUP | 脚本原页暂停并请求AI，先等待有限恢复 |
| POPUP wrong | 脚本使错误记忆失效、保留完整错选组合、最多三次准备；网站可能强制回看数分钟 |
| POPUP needs-continue | 已判对但未继续，原页有限重试；不要重开并再次提交已正确的弹窗 |
| POPUP submitted, correct:null | 页面直接关闭，继续播放但不报告“答对” |
| VIDEO_RECOVERY | 最多两次帧/卡顿恢复，整个视频仍受总预算限制 |
| ACCELERATION seek-probe | 先记录跳转accepted/blocked/unavailable；通过后才启用16倍，被拦直接走2倍兜底 |
| ACCELERATION shadow-16 | 记录真实16倍与页面读值1；默认须先有成功的拖拽探测 |
| ACCELERATION_FALLBACK | 探测或加速未通过，移除影子属性、重开并尝试从0以2倍重播；下一视频仍独立探测 |
| restart-blocked | 无法从0正常重播，保留失败信息；不能把高速结束当完成 |
| TASK_FAILED / CHAPTER_FAILED | 先记录并让其余范围继续；最终只重跑失败且仍需完成的章节 |
| CAPTCHA / LOGIN / ACCOUNT_LOCKED | 停止，按页面要求请用户完成登录或人工验证；不绕过 |
| ENC_EXPIRED | 获取用户当前课程页，使用平台自己的导航拿新签名；不要拼造签名 |
| INCOMPLETE | 不是全部成功，读取报告失败项，不自动全课程重跑 |
| 提交触发但未确认 | 先只读回顾页或状态；禁止直接再次submit或redo |

## Agent补充视频答案

Agent默认使用 `--accelerate --rate 2`，逐视频先探测拖拽、通过后跳转＋16倍，未通过则2倍兜底。回退会尝试把位置恢复到0；若页面仍有弹窗，先处理再重播。进程停止或失败后会清理影子属性；真实倍速与reportedRate分开记录。恢复与AI均共用单视频总时间预算，不能无限重试。历史课程策略不代替当前视频探测，16倍实际能否完成仍以平台确认为准。

脚本无法形成新答案时，先让当前进程结束或协作停止。读取 `<课程runtime>/video-questions.json`、`video-memory.json` 与必要局部PNG。题目key取日志或questions文件，不自行重新计算；图片身份还绑定截图摘要。

根据可核验材料或截图解题后使用：

```powershell
node "<SKILL_DIR>/scripts/cx.js" remember $courseUrl '题目key' '[0,2]'
```

remember检查题目身份、选项数量、单多选限制与平台已判错组合，保留tried/triedPicks，写入 `source:agent-reviewed, verified:false`，不改变任务完成状态。Agent不能仅凭猜测覆盖已有平台验证答案，不能删除错选历史来重复尝试。若所有有依据的方式都无法解决，报告该任务尚未完成并请求缺失信息。

普通AI答案经平台判对后才标verified；AI一致票不等于事实正确。平台若强制回看，正确后再次到达出题位置可复用已验证答案。

## 页面结构不兼容

使用inspect和相关帧截图定位，不同时运行另一个执行进程。必要时按当前环境浏览器工具的使用指引辅助操作，并把辅助步骤记入运行记录；不能把辅助成功算成脚本全自动通过。用户若要求冻结代码，测试过程中只记录故障与辅助，不修改源码。未要求冻结时，也先确认根因再作最小修复。
