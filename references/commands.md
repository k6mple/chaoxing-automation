# 命令与答案

所有命令使用同一入口 `node "<SKILL_DIR>/scripts/cx.js"`。以下把它简称为 `cx`，不是另装的全局程序。课程通常直接使用用户提供的完整课程URL；URL在shell中整体加引号，避免其中的 `&` 被解释。

```powershell
cx list $courseUrl
cx scan $courseUrl 章节ID
cx run $courseUrl 章节ID1,章节ID2 --ai --submit --accelerate --rate 2
cx video $courseUrl 章节ID --no-ai
cx video $courseUrl 章节ID --accelerate --rate 2
cx progress $courseUrl
cx stop
```

先用list确认章节名与ID，不能把“5.13”当成章节ID。显式指定的章节会被读取，即使待办为0。未指定章节的run默认处理全课程待办，只有用户要求整课时才这样运行。

| 目标 | 命令 |
|---|---|
| 登录/读取进度/章节 | login / status / list |
| 查看附件或页面差异 | scan / inspect；可加 --output 文件路径 |
| 只运行视频 | video需章节ID；videos可批量 |
| 视频与作业顺序运行 | run；默认测验只预览 |
| 导出测验原题 | quiz；加密题会保存本地截图 |
| 只生成答案文件 | answers --ai --output 文件路径 |
| 填答预览或正式提交 | solve --answers 文件路径 或 solve --ai；正式提交加 --submit |
| 内嵌多个作业 | works-extract / works-fill；必要时 --card 和 --work-index |
| 已批改答案读取 | harvest；只读取平台公开回顾答案 |
| 离线准备已采集视频题 | prepare --ai |
| Agent修正视频单题 | remember 课程URL或key 题目key '[0,2]'，下标从0开始 |
| 本地进度/停止 | progress [课程URL或key] / stop，始终使用相同CX_DATA |

`--limit` 在scan中限制章节数，在run/videos中限制实际尝试的任务数；失败任务也计数。`--card`、`--work-index`从0开始，用于定位多个卡片/作业。视频 `--no-ai` 关闭默认AI，`--unknown pause`默认暂停未解题，`--unknown skip`会记录并尝试页面允许的继续操作。禁止借助skip伪称已作答。

`--max-ms` 为单视频全流程耗时预算，包含AI、加速与恢复，默认40分钟；`--rate`支持0.5–2的普通播放速度。Agent默认为video/videos/run添加 `--accelerate --rate 2`：先探测跳到90%，成功才启用影子16倍；探测或加速失败统一回退2倍。原始CLI未带开关时仍普通播放。`--accelerate --no-seek` 仅供用户明确要求只用16倍、不探测拖拽时使用。`--strategy batch`默认两轮批量及分歧复核，`legacy`为逐题三次采样，主要供回归比较。

加速只改变媒体播放策略，仍等待真实任务标记。跳转被拦则不启用16倍，重开后尝试从0以2倍重播。当前可见或已记录待答题不跳过，尚未出现的题目可能因向前跳转不再遇到。每课video-policy.json保留最近结果供诊断，不跳过后续视频的独立探测，无需清除历史策略。2倍仍未通过且真实心跳明确未通过时，脚本保留一次1倍恢复；所有阶段共用原总预算。

## 显式测验答案

答案JSON为按qid的对象或按题序的数组。题号取自当前 `quiz-*.json`，选项使用实际键。多选用完整集合，填空用按空序排列的完整文本数组，简答需明确文字/HTML答案：

```json
{
  "题号1": ["A", "C"],
  "题号2": false,
  "题号3": ["第一个空", "第二个空"],
  "题号4": "<p>明确提供的简答内容</p>"
}
```

Agent可读本地截图识别加密/图片题，然后提供显式答案文件，再执行 `solve --answers`，不必把题目另发到第三方API。程序核对原题干/选项/隐藏答案，支持已有页面填答的反选和局部重渲染校验。题目变化或答案不完整会停止提交。只有用户授权时加 `--submit`。

多章答案文件可按章节ID嵌套。课程别名可由用户自行在 `<DATA_DIR>/courses.json` 配置 courseId、clazzId、cpi、enc及可选name；分发包不携带任何真实课程别名或签名。
