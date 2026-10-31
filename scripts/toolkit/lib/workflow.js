const { playVideo, questionKey, memoryAnswer } = require('./video');
const { askLLM, optionKey } = require('./answer');
const platform = require('./platform');
const { sleep } = require('./browser');
const config = require('../config');
const { recognize } = require('./vision');
const { completeVision } = require('./ai');
const { isFatal, isTransient } = require('./recovery');

async function prepareVideoAnswer(question, context = '', { vision = true, cacheFile, log, request, visionRequest = completeVision, signal } = {}) {
  const q = { qid: questionKey(question), stem: question.q, type: question.multi ? '多选' : question.type, opts: question.opts.map((t, i) => ({ k: String.fromCharCode(65 + i), t })) };
  const rejectedAnswers = (question.needsVisual || question.encrypted) && question.triedPicks
    ? question.triedPicks.map(picks => picks.map(i => q.opts[i]?.k)).filter(keys => keys.length && keys.every(Boolean))
    : (question.tried || []).map(texts => texts.map(text => q.opts.find(o => o.t === text)?.k)).filter(keys => keys.length && keys.every(Boolean));
  let solving = q, options = { context, rejectedAnswers, signal, ...(request ? { request } : {}) };
  if (question.needsVisual || question.encrypted) {
    if (!vision) return { error: '截图识图已关闭，无法处理图片或加密题' };
    try {
      const row = (await recognize([{ ...q, needsVisual: question.needsVisual, imagePath: question.imagePath }], { cacheFile, log, request: input => visionRequest({ ...input, signal }) })).get(q.qid);
      solving = { ...q, stem: [row.stem, row.visualContext].filter(Boolean).join('\n'), opts: row.opts };
      if (question.needsVisual) options.request = input => visionRequest({ ...input, images: [question.imagePath], signal });
    } catch (error) { return { error: error.message }; }
  }
  const result = await askLLM(solving, options);
  if (!result.keys) return { error: result.error, errors: result.errors, samples: result.samples };
  const picks = result.keys.map(k => q.opts.findIndex((option, i) => optionKey(option, i) === k));
  return { correct: picks.map(i => question.opts[i]), picks, tried: question.tried || [], triedPicks: question.triedPicks || [], verified: false, source: solving === q ? 'ai' : 'vision-ai', votes: result.votes, samples: result.samples };
}

async function runVideo(session, course, chapterId, task, { playback, ai = true, context = '', prepare = prepareVideoAnswer, saveMemory = () => {}, log = () => {}, play = playVideo, openChapter = platform.openChapter, hasPopup = async () => {
  const { frame } = await platform.attachmentFrame(session.page, task);
  return frame.evaluate(() => Boolean([...document.querySelectorAll('.ans-videoquiz')].find(el => el.offsetParent !== null)));
}, confirm = async () => {
  await session.page.reload({ waitUntil: 'domcontentloaded' });
  const { container } = await platform.attachmentFrame(session.page, task);
  return container.evaluate(el => el.classList.contains('ans-job-finished'));
}, wait = sleep }) {
  const attempts = new Map(), continuations = new Map();
  const totals = { answered: 0, submitted: 0, skipped: 0, questions: [] };
  const started = Date.now(), budget = playback.maxMs || 2400000;
  const fast = playback.acceleration, accelerationAttempts = [];
  let fastUsed = false, fastFallback = false, fastFailure, restart = false;
  let fallback = false, recoveries = 0, pendingQuestion = playback.pendingQuestion, resume = Boolean(playback.resume);
  const finish = result => ({ ...result, ...totals, pendingQuestion, elapsed: Math.round((Date.now() - started) / 1000), recoveries,
    ...(fast ? { acceleration: { requested: true, used: fastUsed, verified: result.status === 'completed' && fastUsed && !fastFallback && (result.actualRate ?? result.acceleration?.actualRate ?? 16) >= 15, fellBack: fastFallback, reason: fastFailure, seek: fast.seekResult || null, attempts: accelerationAttempts } } : {}),
  });
  const check = () => playback.signal?.throwIfAborted();
  const useNormal = async reason => {
    fastFailure = reason; fastFallback = true; playback.acceleration = null; playback.rate = 2; restart = true;
    log('ACCELERATION_FALLBACK', { chapterId, from: 16, to: playback.rate, reason });
    await wait(config.intervalMs); check(); await openChapter(session.page, course, chapterId); resume = true;
  };
  for (let cycle = 0; cycle < 80; cycle++) {
    check();
    const remaining = budget - (Date.now() - started);
    if (remaining <= 0) return finish({ status: 'timeout', reason: '视频总耗时达到上限' });
    let result;
    try { result = await play(session.page, task, { ...playback, maxMs: remaining, pendingQuestion, resume, restart }); }
    catch (error) {
      check();
      if (playback.acceleration && error.code === 'ACCELERATION_UNAVAILABLE') { fastUsed = true; await useNormal(error.message); continue; }
      if (isFatal(error) || !isTransient(error) || recoveries >= 2) throw error;
      log('VIDEO_RECOVERY', { chapterId, attempt: ++recoveries, error: error.message });
      await wait(config.intervalMs); check();
      await openChapter(session.page, course, chapterId); resume = true; continue;
    }
    for (const name of ['answered', 'submitted', 'skipped']) totals[name] += result[name] || 0;
    totals.questions.push(...(result.questions || []));
    if (playback.acceleration && !result.already) {
      fastUsed = true;
      accelerationAttempts.push({ status: result.status, reason: result.reason, ...result.acceleration });
    }
    pendingQuestion = result.pendingQuestion;
    restart = Boolean(result.restartPending);
    resume = true;
    if (result.status === 'needs-answer' && result.reason === 'needs-continue') {
      const key = result.questions?.at(-1)?.key || 'continue';
      const count = (continuations.get(key) || 0) + 1; continuations.set(key, count);
      if (count > 2) return finish(result);
      log('CONTINUE_RETRY', { chapterId, key, attempt: count });
      await wait(500); continue; // Stay in the already-graded popup; never reopen or resubmit it.
    }
    if (result.status === 'needs-answer' && ['needs-answer', 'wrong'].includes(result.reason) && ai) {
      const question = result.questions.at(-1);
      const key = question && questionKey(question);
      if (!question || memoryAnswer(question, playback.memory)) return finish(result);
      const count = (attempts.get(key) || 0) + 1; attempts.set(key, count);
      if (count > 3) return finish({ ...result, reason: '同一弹窗 AI 准备达到 3 次上限' });
      log('PREPARE_POPUP', { chapterId, key, question: question.q, attempt: count, inPlace: true });
      // playVideo's finally has paused the video. Keep its DOM/checkpoint intact.
      // If this player auto-closes the popup, only then reopen once to reacquire it.
      const previous = playback.memory[key] || {};
      let answer;
      const deadline = AbortSignal.timeout(Math.max(1, budget - (Date.now() - started)));
      const signal = playback.signal ? AbortSignal.any([playback.signal, deadline]) : deadline;
      try { answer = await prepare({ ...question, tried: previous.tried || [], triedPicks: previous.triedPicks }, context || course.name, { signal }); }
      catch (error) { check(); answer = { error: error.message }; }
      check();
      if (Date.now() - started >= budget) return finish({ status: 'timeout', reason: 'AI 等待已用尽视频总耗时' });
      if (answer.error) {
        log('ANSWER_UNRESOLVED', { key, ...answer });
        if (count < 3) { await wait(config.intervalMs); continue; }
        return finish({ ...result, reason: answer.error });
      }
      const candidate = { ...previous, ...answer, tried: previous.tried || [], triedPicks: previous.triedPicks || [] };
      if (!memoryAnswer(question, { [key]: candidate })) return finish({ ...result, reason: 'AI 返回空答案或重复平台已判错的组合' });
      playback.memory[key] = candidate; await saveMemory(playback.memory);
      pendingQuestion = key;
      const current = await hasPopup();
      if (!current) {
        log('POPUP_REOPEN', { chapterId, key });
        await openChapter(session.page, course, chapterId);
      }
      continue;
    }
    if (playback.acceleration && ['acceleration-rejected', 'stalled', 'timeout'].includes(result.status) && Date.now() - started < budget) {
      await useNormal(result.reason || result.status); continue;
    }
    if (['stalled', 'timeout'].includes(result.status) && recoveries < 2 && Date.now() - started < budget) {
      log('VIDEO_RECOVERY', { chapterId, attempt: ++recoveries, reason: result.status });
      await wait(config.intervalMs); check(); await openChapter(session.page, course, chapterId); continue;
    }
    if (result.status === 'unconfirmed') {
      log('VERIFY_RELOAD', '视频播完后刷新回读一次，检查延迟生效的任务标记');
      if (await confirm()) return finish({ ...result, status: 'completed', confirmation: 'reload' });
      if (playback.acceleration) { await useNormal('加速结束并刷新后，平台仍未确认完成'); continue; }
      const heartbeat = (session.logs || []).filter(entry => task.jobId ? entry.jobId === task.jobId : task.objectId && entry.objectId === task.objectId).at(-1);
      if (!fallback && playback.rate > 1 && heartbeat?.body?.isPassed === false) {
        fallback = true; log('RATE_FALLBACK', { from: playback.rate, to: 1 }); playback.rate = 1;
        restart = Boolean(fast); await wait(config.intervalMs); continue;
      }
    }
    return finish(result);
  }
  return finish({ status: 'needs-answer', reason: '视频处理达到 80 轮上限' });
}

module.exports = { prepareVideoAnswer, runVideo };
