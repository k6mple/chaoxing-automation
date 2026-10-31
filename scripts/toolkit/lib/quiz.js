const { sleep, assertPage } = require('./browser');
const { quizDoc } = require('./platform');
const { questionKind, parseAnswer, validateKeys, askLLM, askBlanks } = require('./answer');
const { completeVision } = require('./ai');
const { solveBatch } = require('./batch-answer');

function solvingQuestion(question) {
  const recognized = question.recognition;
  return recognized ? { ...question, stem: [recognized.stem, recognized.visualContext].filter(Boolean).join('\n'), opts: recognized.opts } : question;
}

async function extract(frame) {
  return frame.evaluate(() => [...document.querySelectorAll('div.singleQuesId')].map((el, i) => ({
    n: i + 1,
    qid: el.getAttribute('data'),
    type: el.querySelector('.newZy_TItle')?.innerText.trim() || (el.querySelector('.num_option_dx') ? '多选' : ''),
    stem: (el.querySelector('.Zy_TItle')?.innerText || '').replace(/\s+/g, ' ').replace(/^\s*【[^】]+】\s*/, '').trim(),
    encrypted: Boolean(el.querySelector('[class*="font-cxsecret"]')),
    needsVisual: Boolean(el.querySelector('.Zy_TItle img, ul.Zy_ulTop img, .Zy_TItle canvas, ul.Zy_ulTop canvas, .Zy_TItle svg, ul.Zy_ulTop svg')),
    fields: [...el.querySelectorAll('textarea, input[type="text"]')].map(input => input.id || input.name),
    opts: [...el.querySelectorAll('ul.Zy_ulTop li')].map(li => {
      const marker = li.querySelector('.num_option, .num_option_dx');
      const clone = li.cloneNode(true);
      clone.querySelectorAll('.num_option, .num_option_dx, input').forEach(node => node.remove());
      return { k: marker?.getAttribute('data') || null, t: (clone.textContent || '').replace(/\s+/g, ' ').trim() };
    }),
  })));
}

async function buildPlan(questions, { answers = {}, ai = false, context = '', request, visionRequest = completeVision, strategy = 'batch', onBatchAudit = () => {}, log = () => {} } = {}) {
  if (!questions.length) throw new Error('没有题目，拒绝生成空计划');
  const ids = questions.map(q => q.qid);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('题目 ID 缺失或重复');
  if (!['batch', 'legacy'].includes(strategy)) throw new Error('作答策略须为 batch 或 legacy');
  const pending = questions.filter((q, i) => (Array.isArray(answers) ? answers[i] : answers[q.qid]) == null && questionKind(q) !== 'text' && ((!q.encrypted && !q.needsVisual) || q.recognition));
  const batch = ai && strategy === 'batch' && pending.length ? await solveBatch(pending.map(solvingQuestion), { context, ...(request ? { request } : {}), visionRequest, log }) : null;
  if (batch) await onBatchAudit(batch.audit);
  const plan = [];
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    const kind = questionKind(question);
    const supplied = Array.isArray(answers) ? answers[i] : answers[question.qid];
    const item = { qid: question.qid, stem: question.stem, kind, opts: question.opts, fields: question.fields };
    const recognized = question.recognition;
    const readable = (!question.encrypted && !question.needsVisual) || Boolean(recognized);
    const solving = solvingQuestion(question);
    const options = { context, ...(request ? { request } : {}) };
    if (question.needsVisual && recognized) {
      if (!question.imagePath) throw new Error(`题目 ${question.qid}: 缺少图片题原始截图`);
      options.request = input => visionRequest({ ...input, images: [question.imagePath] });
    }
    if (recognized) item.recognition = recognized;
    if (kind === 'blank') {
      if (supplied !== undefined && supplied !== null) item.texts = Array.isArray(supplied) ? supplied : [supplied];
      else if (ai && readable) Object.assign(item, batch ? batch.results.get(question.qid) : await askBlanks(solving, options), { source: batch ? 'batch-ai' : 'ai' });
      else item.error = question.encrypted ? '检测到自定义加密字体，请看截图并提供填空答案' : '填空题缺少答案';
      if (!item.texts || !item.fields?.length || item.texts.length !== item.fields.length || item.texts.some(value => typeof value !== 'string' || !value.replace(/<[^>]*>/g, '').trim())) item.error ||= '填空答案为空或与输入域数量不一致';
    } else if (kind === 'text') {
      if (typeof supplied !== 'string' || !supplied.replace(/<[^>]*>/g, '').trim()) item.error = '文字题缺少人工答案';
      else item.text = supplied;
    } else if (supplied !== undefined && supplied !== null) {
      try {
        item.keys = validateKeys(Array.isArray(supplied) ? supplied : parseAnswer(supplied, question), question);
        item.source = 'file';
      } catch (error) { item.error = error.message; }
    } else if (ai && readable) {
      const result = batch ? batch.results.get(question.qid) : await askLLM(solving, options);
      Object.assign(item, result, { source: batch ? 'batch-ai' : recognized ? 'vision-ai' : 'ai' });
    } else item.error = question.encrypted ? '检测到自定义加密字体，请看截图并提供答案' : question.needsVisual ? '题目包含图片/图表，请看截图并提供答案' : '没有答案，请提供 --answers 或使用 --ai';
    plan.push(item);
  }
  return plan;
}

function assertPlan(plan) {
  if (!Array.isArray(plan) || !plan.length) throw new Error('空答题计划，拒绝填答/提交');
  const ids = plan.map(item => item.qid);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('答题计划 ID 缺失或重复');
  for (const item of plan) {
    if (item.error) throw new Error(`题目 ${item.qid}: ${item.error}`);
    if (item.kind === 'blank') {
      if (!item.fields?.length || item.texts?.length !== item.fields.length || item.texts.some(value => typeof value !== 'string' || !value.replace(/<[^>]*>/g, '').trim())) throw new Error(`题目 ${item.qid}: 填空数量或内容不合法`);
    } else if (item.kind === 'text') {
      if (!item.text?.replace(/<[^>]*>/g, '').trim()) throw new Error(`题目 ${item.qid}: 文字答案为空`);
    } else validateKeys(item.keys, { ...item, type: item.kind === 'multi' ? '多选' : item.kind === 'judge' ? '判断' : '单选' });
  }
}

// The same browser-side function performs filling and the final, fresh verification.
async function formOperation(frame, plan, write) {
  assertPlan(plan);
  return frame.evaluate(async ({ plan, write }) => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const rows = () => [...document.querySelectorAll('div.singleQuesId')];
    const find = qid => rows().find(el => el.getAttribute('data') === qid);
    const normKeys = value => {
      const text = String(value || '').trim().toLowerCase();
      return /^(true|false)$/.test(text) ? [text] : [...new Set(text.replace(/[^a-z]/g, '').split(''))].sort();
    };
    const read = qid => [...(find(qid)?.querySelectorAll('input[name]') || [])].find(input => input.name === `answer${qid}`)?.value || '';
    const same = (left, right) => JSON.stringify(left.map(String).map(k => k.toLowerCase()).sort()) === JSON.stringify(right.map(String).map(k => k.toLowerCase()).sort());
    const editor = id => Object.entries(window.UE?.instants || {}).map(([key, value]) => ({ key, value })).find(({ key, value }) => key === id || value.key === id || value.textareaId === id)?.value;
    const textContent = html => { const div = document.createElement('div'); div.innerHTML = html; return div.textContent.replace(/\s+/g, ' ').trim(); };
    const field = id => [...document.querySelectorAll('textarea, input[type="text"]')].find(input => input.id === id || input.name === id);
    const readText = id => { const ed = editor(id); return ed ? textContent(ed.getContent()) : field(id) ? textContent(field(id).value) : ''; };
    const writeText = (id, value) => {
      const ed = editor(id);
      if (ed) { ed.setContent(value); if (typeof ed.sync === 'function') ed.sync(); return; }
      const input = field(id); if (!input) throw new Error(`找不到输入域 ${id}`);
      input.value = textContent(value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const clickKey = async (qid, key) => {
      const marker = [...(find(qid)?.querySelectorAll('.num_option, .num_option_dx') || [])].find(el => String(el.getAttribute('data')).toLowerCase() === String(key).toLowerCase());
      if (!marker) throw new Error(`选项 ${key} 不存在`);
      // Site handlers are normally bound to the li; query it again for every click.
      const li = marker.closest('li');
      if (!li) throw new Error('选项缺少 li');
      li.click(); await sleep(700);
    };
    const ids = rows().map(el => el.getAttribute('data'));
    if (!ids.length || ids.length !== plan.length || new Set(ids).size !== ids.length || plan.some(p => !ids.includes(p.qid))) throw new Error('页面题目集合与计划不一致');
    for (const item of plan) {
      const el = find(item.qid);
      const stem = (el.querySelector('.Zy_TItle')?.innerText || '').replace(/\s+/g, ' ').replace(/^\s*【[^】]+】\s*/, '').trim();
      const options = [...el.querySelectorAll('ul.Zy_ulTop li')].map(li => {
        const marker = li.querySelector('.num_option, .num_option_dx');
        const clone = li.cloneNode(true); clone.querySelectorAll('.num_option, .num_option_dx, input').forEach(node => node.remove());
        return { k: marker?.getAttribute('data') || null, t: (clone.textContent || '').replace(/\s+/g, ' ').trim() };
      });
      if (stem !== item.stem || JSON.stringify(options) !== JSON.stringify(item.opts)) throw new Error(`题目 ${item.qid}: 题干或选项已变化，请重新生成计划`);
      if (item.fields && JSON.stringify([...el.querySelectorAll('textarea, input[type="text"]')].map(input => input.id || input.name)) !== JSON.stringify(item.fields)) throw new Error(`题目 ${item.qid}: 输入域已变化`);
    }
    for (const item of plan) {
      if (!write) continue;
      find(item.qid).scrollIntoView({ block: 'center' });
      if (item.kind === 'text' || item.kind === 'blank') {
        const fields = item.fields?.length ? item.fields : [`answer${item.qid}`];
        const texts = item.kind === 'blank' ? item.texts : [item.text];
        if (fields.length !== texts.length) throw new Error(`题目 ${item.qid}: 输入域数量不匹配`);
        fields.forEach((id, index) => writeText(id, texts[index])); continue;
      }
      const target = item.keys.map(k => String(k).toLowerCase());
      for (let attempt = 0; attempt < 3; attempt++) {
        let current = normKeys(read(item.qid));
        if (same(current, target)) break;
        if (item.kind === 'multi') {
          for (const key of current) if (!target.includes(key)) await clickKey(item.qid, key);
        }
        for (const key of target) {
          current = normKeys(read(item.qid));
          if (!current.includes(key)) await clickKey(item.qid, key);
        }
      }
    }
    return plan.map(item => {
      if (item.kind === 'text' || item.kind === 'blank') {
        const fields = item.fields?.length ? item.fields : [`answer${item.qid}`];
        const texts = item.kind === 'blank' ? item.texts : [item.text];
        const got = fields.map(readText);
        return { qid: item.qid, ok: got.length === texts.length && got.every((value, i) => Boolean(value) && value === textContent(texts[i])), got };
      }
      const got = read(item.qid);
      return { qid: item.qid, want: item.keys, got, ok: Boolean(got) && same(normKeys(got), item.keys) };
    });
  }, { plan, write });
}

function assertReport(report, plan) {
  assertPlan(plan);
  if (!Array.isArray(report) || report.length !== plan.length || new Set(report.map(r => r.qid)).size !== plan.length || plan.some(p => !report.some(r => r.qid === p.qid && r.ok === true))) throw new Error(`填答校验失败：${JSON.stringify(report)}`);
}

async function fill(frame, plan) {
  const report = await formOperation(frame, plan, true); assertReport(report, plan); return report;
}

async function submit(page, plan, options = {}) {
  const checkAbort = () => options.signal?.throwIfAborted();
  checkAbort();
  const frame = await quizDoc(page, { openWork: false });
  assertReport(await formOperation(frame, plan, false), plan);
  const button = frame.locator('a.btnSubmit, a.completeBtn').filter({ visible: true });
  if (await button.count() !== 1) throw new Error('找不到唯一提交按钮，停止提交');
  checkAbort();
  await button.click();
  await sleep(1500);
  for (const candidate of page.frames()) {
    checkAbort();
    const clicked = await candidate.evaluate(() => {
      const buttons = [...document.querySelectorAll('a.jb_btn, a.layui-layer-btn0, [role="dialog"] button, .popBottom a')].filter(el => el.offsetParent !== null && /^(提交|确定|确认)$/.test(el.innerText.trim()));
      if (buttons.length > 1) throw new Error('确认弹窗按钮不唯一');
      if (buttons[0]) { buttons[0].click(); return true; }
      return false;
    }).catch(error => { if (!/detached|destroyed|navigation/i.test(error.message)) throw error; return false; });
    if (clicked) break;
  }
  const deadline = Date.now() + (options.timeoutMs || 30000);
  while (Date.now() < deadline) {
    checkAbort();
    await assertPage(page);
    for (const candidate of page.frames()) {
      try {
        const result = await candidate.evaluate(() => {
          if (!document.querySelector('div.singleQuesId') || document.querySelector('a.btnSubmit, a.completeBtn')) return null;
          const text = document.body.innerText.replace(/\s+/g, ' ');
          const score = text.match(/本次成绩\s*([\d.]+)\s*分/);
          return score ? { status: 'graded', score: Number(score[1]) } : /待批阅/.test(text) ? { status: 'pending-review' } : /已完成/.test(text) ? { status: 'completed' } : null;
        });
        if (result) return result;
      } catch (error) { if (!/detached|destroyed|navigation/i.test(error.message)) throw error; }
    }
    await sleep(500);
  }
  throw new Error('已触发提交但无法确认结果，请人工检查；不要直接重复提交');
}

async function harvest(frame) {
  return frame.evaluate(() => [...document.querySelectorAll('div.singleQuesId')].map(el => ({
    qid: el.getAttribute('data'),
    correct: el.querySelector('.correctAnswer .answerCon')?.innerText.trim() || null,
    mine: el.querySelector('.myAnswer .answerCon')?.innerText.trim() || null,
    stem: el.querySelector('.Zy_TItle')?.innerText.trim() || '',
  })));
}

module.exports = { extract, buildPlan, assertPlan, formOperation, assertReport, fill, submit, harvest };
