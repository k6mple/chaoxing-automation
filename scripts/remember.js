const fs = require('node:fs');
const path = require('node:path');
const { resolveCourse } = require('./toolkit/lib/course');
const { readJson, writeJson, courseDirectory, acquireLock } = require('./toolkit/lib/store');
const { questionKey, memoryAnswer } = require('./toolkit/lib/video');
const { activeRun } = require('./control');

function remember(input, key, value) {
  if (activeRun()?.alive) throw new Error('先stop并确认进程停止，再写入答案，避免覆盖运行中的记忆');
  const directory = courseDirectory(resolveCourse(input));
  const release = acquireLock([`course:${directory}`]);
  try {
    const question = readJson(path.join(directory, 'video-questions.json'), {})[key];
    if (!question || questionKey(question) !== key) throw new Error('题目key不存在或身份不匹配，请读取当前video-questions.json');
    let picks;
    try { picks = JSON.parse(value); } catch { throw new Error('答案必须是JSON下标数组，如 [0,2]'); }
    if (!Array.isArray(picks) || !picks.length || new Set(picks).size !== picks.length || picks.some(i => !Number.isInteger(i) || i < 0 || i >= question.opts.length) || (!question.multi && picks.length !== 1)) throw new Error('选项下标、重复项或单多选数量不合法');
    const file = path.join(directory, 'video-memory.json'), memory = readJson(file, {}), previous = memory[key] || {};
    if (previous.verified) throw new Error('已有平台验证答案，无需改写；请复用记忆重跑');
    const candidate = { ...previous, correct: picks.map(i => question.opts[i]), picks, verified: false, source: 'agent-reviewed' };
    if (!memoryAnswer(question, { [key]: candidate })) throw new Error('该组合已被平台判错，或不能与当前题目可靠匹配；保留错选记录');
    memory[key] = candidate; writeJson(file, memory);
    fs.appendFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event: 'AGENT_ANSWER_SAVED', data: { key, picks, verified: false } }) + '\n');
    return { saved: true, key, picks, verified: false, file };
  } finally { release(); }
}
module.exports = { remember };
