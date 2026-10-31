# 结果契约与验证边界

## 文件

默认位于 `<DATA_DIR>/runtime/<courseId>-<clazzId>-<cpi>/`，账号上下文隔离。JSON原子写入，损坏文件会报错，不静默丢弃历史。课程完整URL、登录profile、题目与截图均可能含个人数据，只留在用户数据目录，不打包进Skill。

| 文件 | 解释 |
|---|---|
| events.jsonl | 带UTC时间的事件流，跨多次运行累积；分析本轮时按开始时间或字节偏移截取 |
| run-report.json | 最近一次run/video/videos的范围、处理数、失败项；可能被下一轮覆盖 |
| tasks.json | 当前/历史任务状态、播放位置、答题与真实心跳；历史completed不能代替线上回读 |
| jobs.json | 最近一次扫描涉及的章节与附件，不保证覆盖全课；required且finished才是该任务线上完成证据 |
| video-questions.json / video-memory.json | 题目与答案；verified、source、tried、triedPicks必须区分 |
| video-policy.json | 正常速度和加速结果；acceleration中supported/seekAllowed/reason为课程历史策略，不是其他课程的保证 |
| video-screenshots/ / vision-*/ | 加密/图片题的本地PNG，Playwright Locator.screenshot生成 |
| quiz-* / recognized-* / plan-* / fill-* / batch-* | 原题、识读对应、计划、实际填答校验与批量采样审计 |
| correct-answers.json | 平台回顾页已公开的答案采集 |

`<DATA_DIR>/control/active-run.json` 是 Skill 进程生命周期；progress把仍标running但PID已不存在的进程显示为crashed。`control/stop.json` 的令牌只对对应本轮生效，不会让下一轮被旧请求误停。

## 完成判定

- 视频 `completed, confirmation:online-marker, ended:false` 表示平台已通过，视频无需播到结尾。t/duration是退出时位置，不表示用了拖动。初始已完成且无当前弹窗时可能返回already:true。
- 可选加速结果含acceleration.requested/used/verified/fellBack及尝试记录；只有真实确认完成才可能verified。fellBack=true表示加速未通过并转正常重播。PLAYING中的rate为原型getter读取的真实倍速，reportedRate为实例读值，影子模式通常分别为16与1。截图、任务标记及心跳仍由真实页面产生，不合成心跳。
- 视频ended但未通过为unconfirmed；脚本刷新回读一次，真实心跳明确未通过时最多降到1倍正常重播。超时/卡顿不是completed。
- 测验graded附带score；pending-review表示待人工批阅，不能说获得满分；preview只表示填答核验完成，尚未提交。
- 弹窗answered且correct:true才有明确判对反馈；submitted且correct:null没有判分证据。wrong表示一次错误，后续恢复成功仍要计入耗时和错题历史。
- run-report.completed表示该命令队列处理结束；若测验默认预览、包含未支持任务、用户范围之外的章节或未扫描部分，不能声称整课完成。用户中途缩小范围时按最终范围验收。

## 已有实测依据（2026-10-30）

继承引擎已在真实课程完成串行视频、未知弹窗原页AI、任务跳转、10道加密题识图、两轮批量作答与提交后100分回读。一次判断题AI首次错误后，程序自动排除错答、再次AI判对并继续，平台强制回看180视频秒，恢复无需人工改答案。

提前完成策略真实测试在975.606/1043.456秒（约93.5%）退出，真实心跳isPassed=true、isdrag=0，ended=false。此数据是某一门课的实测，不能认定所有课都在90%或同一倍速通过。

复制的单元及隔离浏览器回归覆盖多选反选、题目变化、提交前校验、截图识读、两轮分歧、正确后延迟继续、错误答案恢复、提前完成与当前弹窗优先等。环境/封装测试另外验证移出原项目后可执行、合作停止、离线进度和答案记忆校验。

不支持自动阅读必做PPT/PDF、独立考试、直播、讨论或PBL互评；这些任务应明确报告未支持。Skill封装的离线验证不等于在每个账号、课程和播放器版本上都已验证。以后新增能力按实际证据更新本文件，不复制包含账号签名或私人题目的历史日志。
