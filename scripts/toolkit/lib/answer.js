const { complete } = require('./ai');
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function judgeValue(text) {
  const value = String(text).trim().toLowerCase();
  if (/^(对|正确|是|true|yes|t|√|1)$/.test(value)) return 'true';
  if (/^(错|错误|不正确|否|false|no|f|×|0)$/.test(value)) return 'false';
  return null;
}

function questionKind(question) {
  if (/填空|fill.*blank/i.test(question.type || '')) return 'blank';
  if (/简答|论述|essay|short.answer/i.test(question.type || '') || !question.opts.length) return 'text';
  if (/判断|true.*false/i.test(question.type || '') || question.opts.every(o => judgeValue(o.t) !== null)) return 'judge';
  return /多选|multiple/i.test(question.type || '') ? 'multi' : 'single';
}

function optionKey(option, index) {
  return String(option.k || judgeValue(option.t) || LETTERS[index]);
}

function parseAnswer(text, question) {
  const kind = questionKind(question);
  if (kind === 'text') return null; // Written responses require an explicit supplied answer.
  let value = String(text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    const json = JSON.parse(value);
    if (typeof json === 'string') value = json;
    else if (Array.isArray(json)) value = json.join('');
    else if (json && json.answer !== undefined) value = String(json.answer);
  } catch {}
  value = value.replace(/^(?:答案|正确答案|answer)\s*[:：]\s*/i, '').trim();
  if (kind === 'judge') {
    const truth = judgeValue(value);
    if (truth !== null) {
      const index = question.opts.findIndex(o => judgeValue(o.t) === truth || String(o.k).toLowerCase() === truth);
      return index < 0 ? null : [optionKey(question.opts[index], index)];
    }
  }
  // Only parse a complete answer, never letters hidden in explanatory English.
  if (!/^[A-Z](?:[\s,，、;；/]*[A-Z])*[.。]?$/i.test(value)) return null;
  const letters = [...new Set(value.toUpperCase().replace(/[^A-Z]/g, ''))].sort();
  if (kind !== 'multi' && letters.length !== 1) return null;
  const indices = letters.map(letter => LETTERS.indexOf(letter));
  if (indices.some(i => i < 0 || i >= question.opts.length)) return null;
  return indices.map(i => optionKey(question.opts[i], i));
}

function normalizeKeys(keys) {
  return [...new Set(keys.map(key => String(key).toLowerCase()))].sort();
}

function validateKeys(keys, question) {
  if (!Array.isArray(keys) || !keys.length) throw new Error(`题目 ${question.qid}: 答案为空`);
  const actual = normalizeKeys(keys);
  const allowed = question.opts.map(optionKey).map(k => k.toLowerCase());
  if (actual.some(k => !allowed.includes(k))) throw new Error(`题目 ${question.qid}: 选项不存在`);
  if (questionKind(question) !== 'multi' && actual.length !== 1) throw new Error(`题目 ${question.qid}: 单选/判断题只能选一项`);
  return actual.map(k => question.opts.map(optionKey).find(allowedKey => allowedKey.toLowerCase() === k));
}

function consensus(samples, question) {
  const parsed = samples.map(text => parseAnswer(text, question)).filter(Boolean);
  const votes = {};
  for (const keys of parsed) for (const key of normalizeKeys(keys)) votes[key] = (votes[key] || 0) + 1;
  if (parsed.length < 2) return { keys: null, votes, error: '有效采样不足 2 次' };
  const majority = Math.floor(parsed.length / 2) + 1;
  const picked = Object.keys(votes).filter(k => votes[k] >= majority);
  if (!picked.length || (questionKind(question) !== 'multi' && picked.length !== 1)) return { keys: null, votes, error: '采样没有形成多数票' };
  return { keys: validateKeys(picked, question), votes };
}

async function askLLM(question, { request = complete, context = '', rejectedAnswers = [], signal } = {}) {
  const kind = questionKind(question);
  if (kind === 'text') return { keys: null, error: '文字题需要在答案文件中人工提供' };
  const rejected = rejectedAnswers.map(keys => normalizeKeys(validateKeys(keys, question)));
  const allowed = text => {
    const keys = parseAnswer(text, question);
    return keys && !rejected.some(old => JSON.stringify(old) === JSON.stringify(normalizeKeys(keys)));
  };
  const prompt = [`课程背景：${context || '按题目所属学科作答，不预设具体课程。'}`, `题型：${kind}`, `题目：${question.stem}`, ...question.opts.map((o, i) => `${LETTERS[i]}. ${o.t}`), ...(rejected.length ? [`平台已判错的完整答案组合：${JSON.stringify(rejectedAnswers)}。重新核对事实，不得重复这些组合。多选组合判错不表示其中每个选项都错。`] : []), kind === 'judge' ? '只输出 true 或 false。' : kind === 'multi' ? '逐一判断每个选项，选出全部正确选项，只输出字母组合，例如 ACD。' : '只输出一个选项字母。', '留意题干中的否定词；不要输出解释。'].join('\n');
  const roles = ['核对定义与事实后作答。', '逐项检查选项，留意例外和否定。', '独立解题，核对所有备选项。'];
  const samples = [], errors = [];
  const vote = () => {
    const eligible = samples.filter(allowed);
    const result = consensus(eligible, question);
    // A multi-choice vote must agree on a whole set, not invent a new combination.
    if (result.keys && eligible.filter(text => JSON.stringify(normalizeKeys(parseAnswer(text, question))) === JSON.stringify(normalizeKeys(result.keys))).length < Math.floor(eligible.length / 2) + 1) return { ...result, keys: null, error: '完整答案组合未形成多数票' };
    if (!result.keys && rejected.length) result.error = '复核未形成未被平台判错的新答案';
    return result;
  };
  for (let i = 0; i < 3; i++) {
    signal?.throwIfAborted();
    try { samples.push(await request({ system: `你是严谨的课程答题助手。${roles[i]}`, prompt, temperature: i ? 0.7 : 0, signal })); }
    catch (error) { errors.push(error.message); }
  }
  let result = vote();
  if (!result.keys && samples.length >= 2) {
    signal?.throwIfAborted();
    try { samples.push(await request({ system: '你是独立复核者，请核对题意后给出最终答案。', prompt, temperature: 0, signal })); result = vote(); }
    catch (error) { errors.push(error.message); }
  }
  signal?.throwIfAborted();
  return { ...result, samples, errors };
}

async function askBlanks(question, { request = complete, context = '' } = {}) {
  const count = question.fields?.length || 0;
  if (!count) return { error: '填空题没有可定位的输入域' };
  const samples = [], errors = [], votes = new Map();
  for (let i = 0; i < 3; i++) {
    try {
      const text = await request({ system: '你是严谨的课程答题助手，按题目原文补全填空。', prompt: `课程：${context}\n题目：${question.stem}\n共 ${count} 个空。仅输出 JSON 字符串数组，按空的顺序排列，不要解释。`, temperature: i ? 0.5 : 0, maxTokens: 256 });
      samples.push(text);
      const values = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
      if (!Array.isArray(values) || values.length !== count || values.some(v => typeof v !== 'string' || !v.trim())) continue;
      const normalized = values.map(v => v.trim());
      const key = JSON.stringify(normalized); votes.set(key, (votes.get(key) || 0) + 1);
    } catch (error) { errors.push(error.message); }
  }
  const majority = [...votes].find(([, count]) => count >= 2);
  return majority ? { texts: JSON.parse(majority[0]), samples } : { error: '填空答案未形成两次一致采样', samples, errors };
}

module.exports = { judgeValue, questionKind, optionKey, parseAnswer, normalizeKeys, validateKeys, consensus, askLLM, askBlanks };
