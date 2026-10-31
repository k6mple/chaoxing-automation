const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { sleep, assertPage } = require('./browser');
const { attachmentFrame } = require('./platform');
const { captureQuestion } = require('./vision');
const { setPlayback, restorePlayback, seekVideo } = require('./playback');

function questionKey(question) {
  const identity = [question.q.trim(), [...question.opts].sort()];
  if (question.encrypted || question.needsVisual) identity.push(question.visualHash || 'uncaptured');
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
}

function memoryAnswer(question, memory) {
  const visual = question.encrypted || question.needsVisual;
  if (visual && !question.visualHash) return null;
  const record = memory[questionKey(question)] || (!visual && memory[question.q]);
  const rejected = picks => visual && record?.triedPicks
    ? record.triedPicks.some(old => JSON.stringify([...old].sort()) === JSON.stringify([...picks].sort()))
    : (record?.tried || []).some(texts => JSON.stringify([...texts].sort()) === JSON.stringify(picks.map(i => question.opts[i]).sort()));
  if (visual && Array.isArray(record?.picks)) {
    const picks = record.picks;
    return picks.length && (question.multi || picks.length === 1) && new Set(picks).size === picks.length && picks.every(i => Number.isInteger(i) && i >= 0 && i < question.opts.length) && !rejected(picks) ? picks : null;
  }
  const correct = record?.correct;
  const texts = Array.isArray(correct) ? correct : typeof correct === 'string' ? [correct] : [];
  if (!texts.length || texts.some(text => !question.opts.includes(text))) return null;
  if (!question.multi && texts.length !== 1) return null;
  const picks = [...new Set(texts)].map(text => question.opts.indexOf(text));
  return rejected(picks) ? null : picks;
}

async function readState(frame) {
  return frame.evaluate(() => {
    const video = document.querySelector('video');
    if (!video) return { missing: true };
    const popup = [...document.querySelectorAll('.ans-videoquiz')].find(el => el.offsetParent !== null);
    return {
      t: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
      ended: video.ended, paused: video.paused,
      rate: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate').get.call(video), reportedRate: video.playbackRate,
      question: popup ? {
        q: (popup.querySelector('.tkItem_title')?.innerText || '').replace(/\s+/g, ' ').trim(),
        type: popup.querySelector('.tkTopic_title')?.innerText.trim() || '',
        multi: Boolean(popup.querySelector('input[type="checkbox"]')),
        needsVisual: Boolean(popup.querySelector('.tkItem_title img, li.ans-videoquiz-opt img, canvas, svg')),
        encrypted: Boolean(popup.querySelector('[class*="font-cxsecret"]')),
        opts: [...popup.querySelectorAll('li.ans-videoquiz-opt')].map(el => el.innerText.replace(/\s+/g, ' ').trim().replace(/^[A-Z][、.．]\s*/i, '')),
      } : null,
    };
  });
}

async function handlePopup(frame, question, picks, unknown = 'pause') {
  return frame.evaluate(async ({ question, picks, unknown }) => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const video = document.querySelector('video');
    const popup = [...document.querySelectorAll('.ans-videoquiz')].find(el => el.offsetParent !== null);
    if (!popup) return { action: 'gone' };
    const current = (popup.querySelector('.tkItem_title')?.innerText || '').replace(/\s+/g, ' ').trim();
    const currentOptions = [...popup.querySelectorAll('li.ans-videoquiz-opt')].map(el => el.innerText.replace(/\s+/g, ' ').trim().replace(/^[A-Z][、.．]\s*/i, ''));
    if (current !== question.q || JSON.stringify(currentOptions) !== JSON.stringify(question.opts)) return { action: 'changed' };
    if (picks && (!Array.isArray(picks) || !picks.length || picks.some(i => !Number.isInteger(i) || i < 0 || i >= currentOptions.length) || (!question.multi && picks.length !== 1))) return { action: 'needs-answer', error: '弹窗答案格式错误' };
    const before = video.currentTime;
    if (!video.paused) video.pause();
    const visible = selector => { const el = popup.querySelector(selector); return el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden'; };
    const release = async () => {
      // Correct feedback and the continue button are rendered at different times.
      // Confirm actual dismissal; a successful click alone does not mean success.
      let clickedAt = 0;
      for (let i = 0; i < 50; i++) {
        if (!popup.isConnected || popup.offsetParent === null) {
          if (video.paused) video.play().catch(() => {});
          return true;
        }
        const next = popup.querySelector('#videoquiz-continue');
        if (next?.offsetParent && Date.now() - clickedAt >= 1000) { next.click(); clickedAt = Date.now(); }
        await sleep(100);
      }
      return false;
    };
    if (visible('#spanHas')) return { action: await release() ? 'answered' : 'needs-continue', correct: true };
    if (!picks) return { action: unknown === 'skip' && await release() ? 'skipped' : 'needs-answer' };
    // A failed answer may still be shown; new picks are checked before resubmission.
    const options = () => [...popup.querySelectorAll('li.ans-videoquiz-opt')];
    for (let i = 0; i < options().length; i++) {
      let li = options()[i], input = li.querySelector('input');
      if (!input) return { action: 'needs-answer', error: '选项缺少 input' };
      const wanted = picks.includes(i);
      if (input.checked === wanted || (!wanted && input.type !== 'checkbox')) continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        li = options()[i]; input = li.querySelector('input');
        if (input.checked === wanted) break;
        const target = attempt === 0 ? input : attempt === 1 ? li.querySelector('label') || li : li;
        target.click(); await sleep(100);
      }
    }
    const selected = options().map((li, i) => li.querySelector('input')?.checked ? i : -1).filter(i => i >= 0);
    if (JSON.stringify(selected.sort()) !== JSON.stringify([...picks].sort())) return { action: 'needs-answer', error: '选项未正确勾选' };
    const submit = popup.querySelector('#videoquiz-submit');
    if (!submit) return { action: 'needs-answer', error: '没有弹窗提交按钮' };
    const staleWrong = visible('#spanNot') || visible('#spanNotBack');
    submit.click();
    for (let i = 0; i < 50; i++) {
      if (visible('#spanHas')) return { action: await release() ? 'answered' : 'needs-continue', correct: true };
      if ((visible('#spanNot') || visible('#spanNotBack')) && (!staleWrong || i >= 20)) return { action: 'wrong', correct: false };
      if (!popup.isConnected || popup.offsetParent === null) {
        await sleep(250);
        if (video.currentTime < before - 2) return { action: 'wrong', correct: false };
        // Some player versions remove the popup without a graded-result element.
        // Resume, but leave the cached answer unverified rather than inventing correctness.
        return { action: 'submitted', correct: null };
      }
      await sleep(100);
    }
    return { action: 'needs-answer', error: '无法确认弹窗判题结果' };
  }, { question, picks, unknown });
}

async function playVideo(page, task, { rate = config.rate, maxMs = 2400000, memory = {}, unknown = 'pause', signal, pendingQuestion, resume = false, acceleration, restart = false, captureDirectory = path.join(config.data, 'runtime/screenshots'), onProgress = () => {}, onQuestion = () => {}, onAcceleration = () => {} } = {}) {
  signal?.throwIfAborted();
  if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) throw new Error('播放倍速必须在 0.5–2 之间');
  if (!['pause', 'skip'].includes(unknown)) throw new Error('未知题策略必须是 pause 或 skip');
  const { frame, container } = await attachmentFrame(page, task);
  const finished = () => container.evaluate(el => el.classList.contains('ans-job-finished'));
  if (await finished() && !pendingQuestion && !resume && !(await readState(frame)).question) return { status: 'completed', already: true };
  await frame.waitForSelector('video', { timeout: config.timeoutMs });
  const started = Date.now();
  let lastTime = -1, advancedAt = Date.now(), lastReport = 0, lastQuestion = '', repeated = 0;
  const stats = { answered: 0, submitted: 0, skipped: 0, questions: [], pendingQuestion, restartPending: restart };
  try {
    await setPlayback(frame, { rate });
    let accelerated = false;
    const start = () => frame.evaluate(() => {
      if (![...document.querySelectorAll('.ans-videoquiz')].some(el => el.offsetParent !== null)) document.querySelector('video')?.play().catch(() => {});
    });
    if (!acceleration) await start();
    while (Date.now() - started < maxMs) {
      if (signal?.aborted) throw new Error('任务已中断');
      await assertPage(page);
      const state = await readState(frame);
      if (!state.question && !pendingQuestion && !stats.restartPending && await finished()) {
        // Recheck for a popup that appeared while the parent completion marker was read.
        const current = await readState(frame);
        if (current.question) continue;
        return { status: 'completed', confirmation: 'online-marker', t: current.t, duration: current.duration, ended: current.ended, actualRate: current.rate, elapsed: Math.round((Date.now() - started) / 1000), ...stats };
      }
      if (state.missing) throw new Error('播放器 video 元素消失');
      if (state.question) {
        const question = state.question;
        if (question.encrypted || question.needsVisual) {
          if (!state.paused) await frame.evaluate(() => document.querySelector('video').pause());
          question.imagePath = await captureQuestion(frame, question, path.join(captureDirectory, `${crypto.randomUUID()}.png`), { popup: true });
          question.visualHash = crypto.createHash('sha256').update(fs.readFileSync(question.imagePath)).digest('hex');
        }
        const key = questionKey(question);
        if (pendingQuestion && key === pendingQuestion) { pendingQuestion = null; stats.pendingQuestion = null; }
        repeated = key === lastQuestion ? repeated + 1 : 1; lastQuestion = key;
        if (repeated > 4) return { status: 'needs-answer', reason: '同一弹窗连续未关闭', ...stats };
        const picks = memoryAnswer(question, memory);
        const result = await handlePopup(frame, question, picks, unknown);
        stats.questions.push({ ...question, t: state.t, key });
        if (result.correct === false) {
          const old = memory[key] || memory[question.q] || {};
          const tried = old.tried || [];
          const triedPicks = old.triedPicks || [];
          const rejected = (picks || []).map(i => question.opts[i]);
          if (rejected.length && !tried.some(texts => JSON.stringify([...texts].sort()) === JSON.stringify([...rejected].sort()))) tried.push(rejected);
          if (picks?.length && !triedPicks.some(old => JSON.stringify([...old].sort()) === JSON.stringify([...picks].sort()))) triedPicks.push([...picks]);
          memory[key] = { ...old, correct: null, picks: null, verified: false, tried, triedPicks };
          // Invalidate legacy text-only lookup too; never repeat an answer just proven wrong.
          if (memory[question.q]) memory[question.q].correct = null;
        }
        if (result.correct === true && memory[key]) memory[key].verified = true;
        await onQuestion({ ...question, t: state.t, key, result }, memory);
        if (['needs-answer', 'needs-continue', 'wrong'].includes(result.action)) return { status: 'needs-answer', reason: result.error || result.action, ...stats, pendingQuestion: key };
        if (result.action === 'answered') stats.answered++;
        if (result.action === 'submitted') stats.submitted++;
        if (result.action === 'skipped') stats.skipped++;
        advancedAt = Date.now();
      } else {
        lastQuestion = ''; repeated = 0;
        if (stats.restartPending) {
          const reset = await seekVideo(frame, 0, { timeoutMs: Math.min(config.timeoutMs, maxMs) });
          await onAcceleration({ action: 'normal-restart', ...reset });
          if (!['accepted', 'not-needed'].includes(reset.status)) return { status: 'restart-blocked', reason: '加速未通过，无法从头正常重播', reset, ...stats };
          stats.restartPending = false; lastTime = -1; advancedAt = Date.now();
          await start(); continue;
        }
        if (acceleration && !accelerated && !pendingQuestion) {
          if (acceleration.seek && !acceleration.seekAttempted) {
            const seek = await seekVideo(frame, 0.9, { timeoutMs: Math.min(config.timeoutMs, maxMs) });
            acceleration.seekResult = seek;
            acceleration.seekAttempted = seek.status !== 'deferred';
            stats.acceleration = { actualRate: state.rate, reportedRate: state.reportedRate, seek };
            await onAcceleration({ action: 'seek-probe', ...stats.acceleration });
            if (seek.status === 'deferred') { await sleep(600); continue; }
            if (!['accepted', 'not-needed'].includes(seek.status)) return { status: 'acceleration-rejected', reason: '拖拽探测未通过，改用2倍速', ...stats };
          }
          const speed = await setPlayback(frame, { rate, shadow: true }).catch(error => { error.code = 'ACCELERATION_UNAVAILABLE'; throw error; });
          accelerated = true;
          stats.acceleration = { ...speed, seek: acceleration.seekResult || null };
          await onAcceleration({ action: 'shadow-16', ...stats.acceleration });
          await start(); continue;
        }
        if (accelerated && state.rate < 15) return { status: 'acceleration-rejected', reason: '播放器未保持实际16倍速', actualRate: state.rate, ...stats };
        if (state.t > lastTime + 0.2) { lastTime = state.t; advancedAt = Date.now(); }
        if (state.ended) {
          if (pendingQuestion) return { status: 'needs-answer', reason: '视频已结束，但待处理弹窗未再次出现', pendingQuestion, ...stats };
          for (let i = 0; i < 10; i++) { signal?.throwIfAborted(); if (await finished()) return { status: 'completed', actualRate: state.rate, ...stats }; await sleep(1000); }
          return { status: 'unconfirmed', reason: '视频已结束，任务点尚未确认', actualRate: state.rate, ...stats };
        }
        const stallMs = acceleration ? 15000 : 120000;
        if (Date.now() - advancedAt > stallMs) return { status: 'stalled', reason: `播放进度 ${stallMs / 1000} 秒未前进`, ...stats };
        if (state.paused) await frame.evaluate(() => { document.querySelector('video')?.play().catch(() => {}); });
      }
      if (Date.now() - lastReport > 15000) {
        await onProgress({ ...state, pendingQuestion, question: state.question ? { q: state.question.q } : null, elapsed: Math.round((Date.now() - started) / 1000) });
        lastReport = Date.now();
      }
      await sleep(600);
    }
    return { status: 'timeout', ...stats };
  } finally {
    // A stopped or failed run must not leave an unattended video advancing.
    await frame.evaluate(() => { const video = document.querySelector('video'); if (video && !video.paused) video.pause(); }).catch(() => {});
    if (acceleration) await restorePlayback(frame).catch(() => {});
  }
}

module.exports = { questionKey, memoryAnswer, readState, handlePopup, playVideo };
