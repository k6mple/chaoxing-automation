const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { attach, sleep } = require('./browser');
const { resolveCourse } = require('./course');
const { readJson, writeJson, courseDirectory, acquireLock } = require('./store');
const platform = require('./platform');
const quiz = require('./quiz');
const { prepareVideoAnswer, runVideo } = require('./workflow');
const { recognizeQuiz } = require('./vision');
const { isFatal, taskKey: makeTaskKey, reconcileTasks } = require('./recovery');

const HELP = `学习通工具箱 v2
node scripts/cx.js <命令> <课程key或URL> [章节ID] [选项]

status / list      课程进度与章节列表
inspect           导出当前章节的帧与导航信息（排查页面差异）
scan              扫描附件，输出 jobs.json；默认只扫描待办章节
videos / video    串行正常播放；video 必须指定章节
quiz / answers    导出题目 / 只生成答案文件（不填表）
solve / quizfill  答案文件或 --ai 生成计划、填答；默认不提交
works-extract     扫描作业并逐章导出（多个附件需逐个 --work-index）
works-fill        按答案文件批量填作业；默认不提交
harvest           采集已批改答案（章节ID可逗号分隔）
redo              预览已知答案；--redo 显式开启新一次尝试
prepare           离线为已采集的视频弹窗生成答案记忆（需 --ai）
run               按章节处理视频与测验，默认测验只填不交
login             打开课程等待登录

--chapter ID      限定章节（也可直接放在课程参数后）
--limit N         videos/run 限制任务数；scan 限制章节数
--answers FILE    按 qid 的答案对象或按题序的数组；文字题提供 HTML/文本
--ai              测验开启 AI 作答，自动识读加密/图片题
--no-ai           视频未知题关闭 AI（视频默认自动调用）
--no-vision       关闭加密/图片题的截图识读
--strategy batch|legacy  测验默认两轮批量＋分歧复核，legacy 为逐题三次
--submit          核验完整答案后正式提交测验/作业
--redo            显式点击重做，可能消耗尝试次数
--rate 0.5..2     普通播放倍速，默认2；加速失败统一回退2倍
--accelerate      先探测跳至90%，通过后用影子16倍，失败回退2倍
--no-seek         配合--accelerate，仅影子16倍，不尝试向前跳转
--unknown pause|skip  视频未知题暂停（默认）或记录并点继续
--work-index N    作业附件在本章 .ans-attach-ct 中的序号（从 0 开始）
--card N          本章卡片标签序号（从 0 开始）
--all             扫描全部章节/播放非任务视频
--output FILE     导出位置
--keep-page       结束后保留脚本标签页
环境变量见 README.md。所有命令共用资源锁，禁止同一浏览器并行跑任务。`;

function parseArgs(argv) {
  const flags = new Set(['ai', 'no-ai', 'no-vision', 'submit', 'redo', 'all', 'keep-page', 'help', 'accelerate', 'no-seek']);
  const values = new Set(['chapter', 'limit', 'answers', 'output', 'rate', 'unknown', 'work-index', 'card', 'max-ms', 'context', 'strategy']);
  const options = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const [name, inline] = token.slice(2).split(/=(.*)/s);
    if (flags.has(name)) { if (inline !== undefined) throw new Error(`--${name} 不接受值`); options[name] = true; }
    else if (values.has(name)) {
      const value = inline ?? argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`--${name} 缺少值`);
      options[name] = value;
    } else throw new Error(`未知参数 --${name}`);
  }
  for (const name of ['limit', 'work-index', 'card', 'max-ms']) {
    const zero = ['work-index', 'card'].includes(name);
    if (options[name] !== undefined && (!/^\d+$/.test(options[name]) || (!zero && Number(options[name]) < 1))) throw new Error(`--${name} 必须是${zero ? '非负' : '正'}整数`);
    if (options[name] !== undefined) options[name] = Number(options[name]);
  }
  if (options.rate !== undefined && (!Number.isFinite(Number(options.rate)) || Number(options.rate) < 0.5 || Number(options.rate) > 2)) throw new Error('--rate 必须在 0.5–2 之间');
  if (options.unknown && !['pause', 'skip'].includes(options.unknown)) throw new Error('--unknown 只能是 pause 或 skip');
  if (options.chapter && positional[2]) throw new Error('章节 ID 请只指定一次');
  if (options.ai && options['no-ai']) throw new Error('--ai 与 --no-ai 不能同时使用');
  if (options['no-seek'] && !options.accelerate) throw new Error('--no-seek 需配合 --accelerate');
  if (options.accelerate && !['video', 'videos', 'run'].includes(positional[0])) throw new Error('--accelerate 仅适用于 video/videos/run');
  if (options.strategy && !['batch', 'legacy'].includes(options.strategy)) throw new Error('--strategy 须为 batch 或 legacy');
  return { command: positional[0], courseInput: positional[1], chapter: options.chapter || positional[2], extra: positional.slice(3), options };
}

function loadAnswers(file, chapterId) {
  if (!file) return {};
  const raw = readJson(path.resolve(file));
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') throw new Error('答案文件必须是对象或数组');
  return raw[chapterId] ?? raw;
}

async function startRedo(page) {
  const frame = await platform.quizDoc(page);
  const button = frame.locator('a.jb_btn_bg').filter({ hasText: '重做' });
  if (!await button.count() && await frame.locator('a.btnSubmit, a.completeBtn').count()) return;
  if (await button.count() !== 1) throw new Error('没有唯一的重做按钮；可能不允许再次尝试');
  await button.click(); await sleep(800);
  let confirmed = false;
  for (const candidate of page.frames()) {
    const done = await candidate.evaluate(() => {
      const body = document.body?.innerText || '';
      if (!/重做/.test(body)) return false;
      const buttons = [...document.querySelectorAll('a.jb_btn, [role="dialog"] button, a.layui-layer-btn0')].filter(el => el.offsetParent !== null && /^(确定|确认)$/.test(el.innerText.trim()));
      if (buttons.length !== 1) return false;
      buttons[0].click(); return true;
    }).catch(() => false);
    if (done) { confirmed = true; break; }
  }
  if (!confirmed) throw new Error('未确认重做弹窗，请人工检查');
  await sleep(1500);
}

async function runCli(argv = process.argv.slice(2)) {
  const input = parseArgs(argv);
  if (!input.command || input.options.help || input.command === 'help') { console.log(HELP); return; }
  const course = resolveCourse(input.courseInput);
  const release = acquireLock([`course:${courseDirectory(course)}`]);
  try { return await runResolved(input, course); }
  finally { release(); }
}

async function runResolved(parsed, course, { connect = attach } = {}) {
  let { command, chapter } = parsed;
  const { options, extra } = parsed;
  if (!command || options.help || command === 'help') { console.log(HELP); return; }
  const allowed = ['status', 'list', 'inspect', 'scan', 'map', 'video', 'videos', 'quiz', 'answers', 'solve', 'quizfill', 'works-extract', 'works-fill', 'harvest', 'redo', 'prepare', 'run', 'login'];
  if (!allowed.includes(command)) throw new Error(`未知命令 ${command}，使用 --help 查看`);
  if (command === 'map') command = 'scan';
  const directory = courseDirectory(course);
  const file = name => path.join(directory, name);
  fs.mkdirSync(directory, { recursive: true });
  const log = (event, data) => {
    const row = { at: new Date().toISOString(), event, ...(data === undefined ? {} : { data }) };
    fs.appendFileSync(file('events.jsonl'), JSON.stringify(row) + '\n');
    console.log(new Date(row.at).toLocaleTimeString('zh-CN', { timeZone: config.timezone, hour12: false }), event, data === undefined ? '' : typeof data === 'string' ? data : JSON.stringify(data));
  };
  const memory = readJson(file('video-memory.json'), {});
  const questions = readJson(file('video-questions.json'), {});
  if (command === 'prepare') {
    if (!options.ai) throw new Error('prepare 需要 --ai');
    let unresolved = 0;
    for (const [key, question] of Object.entries(questions)) {
      if (memory[key]?.correct) continue;
      const result = await prepareVideoAnswer(question, options.context || course.name, { vision: !options['no-vision'], cacheFile: file('vision-cache.json'), log });
      if (result.correct) memory[key] = result;
      else { unresolved++; log('ANSWER_UNRESOLVED', { key, error: result.error, errors: result.errors, samples: result.samples }); }
      writeJson(file('video-memory.json'), memory);
    }
    log('PREPARED', { count: Object.values(memory).filter(value => value.correct).length, unresolved });
    if (unresolved) throw new Error(`${unresolved} 道弹窗题尚未生成可靠答案，请检查 API 状态或人工提供记忆`);
    return;
  }
  const chaptersRequired = ['inspect', 'video', 'quiz', 'answers', 'solve', 'quizfill', 'harvest', 'redo'];
  if (chaptersRequired.includes(command) && !chapter) throw new Error(`${command} 需要章节 ID`);
  if (chapter && !/^\d+(,\d+)*$/.test(chapter)) throw new Error('章节 ID 必须是数字，可用逗号分隔');
  if (extra.length && !(command === 'quizfill' && extra.length === 1)) throw new Error('多余的位置参数，请使用 --help');
  if (command === 'quizfill' && !options.answers) options.answers = extra[0];
  if (options.answers) readJson(path.resolve(options.answers)); // Fail before opening any browser.
  const state = readJson(file('tasks.json'), {});
  const videoPolicy = readJson(file('video-policy.json'), {});
  const fastAllowed = Boolean(options.accelerate);
  const seekAllowed = !options['no-seek'];
  const session = await connect({ log });
  let keepPage = Boolean(options['keep-page']);
  const controller = new AbortController();
  const interrupt = () => { controller.abort(); log('INTERRUPTED', '正在保存状态并停止播放器'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const checkAbort = () => { if (controller.signal.aborted) throw new Error('任务已中断'); };
  let touched = 0;
  const atLimit = () => options.limit && touched >= options.limit;
  let activeTask;
  const failures = [];
  const runReport = { startedAt: new Date().toISOString(), command, chapters: chapter?.split(',') || null, status: 'running', failures };
  const reportFile = file('run-report.json');
  const report = status => {
    runReport.status = status;
    if (['run', 'video', 'videos'].includes(command)) writeJson(reportFile, { ...runReport, processed: touched, updatedAt: new Date().toISOString() });
  };
  const saveState = () => writeJson(file('tasks.json'), state);
  const save = (taskKey, result) => { state[taskKey] = { ...result, at: new Date().toISOString() }; saveState(); };

  const runQuiz = async (chapterId, task, mode = 'solve') => {
    checkAbort();
    if (options.redo) await startRedo(session.page);
    const frame = await platform.quizDoc(session.page, { workIndex: task?.index ?? options['work-index'], card: task?.card ?? options.card });
    const extracted = await quiz.extract(frame);
    const suffix = task ? `-${task.card || 0}-${task.index}` : '';
    if ((!options.ai || options['no-vision']) && extracted.some(q => q.encrypted || q.needsVisual)) await session.page.screenshot({ path: file(`quiz-${chapterId}${suffix}.png`), fullPage: true });
    writeJson(options.output && ['quiz', 'works-extract'].includes(mode) ? path.resolve(options.output) : file(`quiz-${chapterId}${suffix}.json`), extracted);
    if (mode === 'quiz' || mode === 'works-extract') { log('EXTRACTED', { chapterId, count: extracted.length }); return; }
    if (mode === 'harvest') {
      const result = await quiz.harvest(frame);
      const db = readJson(file('correct-answers.json'), {});
      db[chapterId] = { ...(db[chapterId] || {}), ...Object.fromEntries(result.filter(q => q.correct).map(q => [q.qid, q])) };
      writeJson(file('correct-answers.json'), db); log('HARVESTED', { chapterId, count: result.filter(q => q.correct).length }); return;
    }
    const form = await frame.locator('a.btnSubmit, a.completeBtn').count();
    if (!form) { log('SKIP_REVIEW', '页面为已交回顾页；未指定 --redo 时不重新开启尝试'); return; }
    let answers = loadAnswers(options.answers, chapterId);
    if (mode === 'redo' && !options.answers) {
      const db = readJson(file('correct-answers.json'), {});
      answers = Object.fromEntries(Object.entries(db[chapterId] || {}).map(([qid, entry]) => [qid, entry.correct]));
    }
    if (!options.answers && mode === 'works-fill' && course.key) {
      const legacyFile = path.join(config.data, 'answers', `works-${course.key}.json`);
      if (fs.existsSync(legacyFile)) answers = loadAnswers(legacyFile, chapterId);
    }
    const prepared = options.ai && !options['no-vision'] ? await recognizeQuiz(frame, extracted, {
      directory: file(`vision-${chapterId}${suffix}`), cacheFile: file('vision-cache.json'), log,
      select: (q, i) => (Array.isArray(answers) ? answers[i] : answers[q.qid]) == null,
    }) : extracted;
    if (prepared.some(q => q.recognition)) writeJson(file(`recognized-${chapterId}${suffix}.json`), prepared);
    const plan = await quiz.buildPlan(prepared, {
      answers, ai: Boolean(options.ai), context: options.context || course.name, strategy: options.strategy || 'batch', log,
      onBatchAudit: audit => writeJson(file(`batch-${chapterId}${suffix}.json`), audit),
    });
    checkAbort();
    writeJson(file(`plan-${chapterId}${suffix}.json`), plan);
    log('PLAN', plan.map(p => ({ qid: p.qid, keys: p.keys, error: p.error, votes: p.votes })));
    quiz.assertPlan(plan);
    if (mode === 'answers') {
      const target = options.output ? path.resolve(options.output) : file(`answers-${chapterId}${suffix}.json`);
      writeJson(target, Object.fromEntries(plan.map(p => [p.qid, p.kind === 'text' ? p.text : p.kind === 'blank' ? p.texts : p.keys])));
      log('ANSWERS_SAVED', target); return;
    }
    const report = await quiz.fill(frame, plan);
    writeJson(file(`fill-${chapterId}${suffix}.json`), report);
    checkAbort();
    if (options.submit) {
      const result = await quiz.submit(session.page, plan, { signal: controller.signal }); save(`quiz:${chapterId}${suffix}`, result); log('SUBMITTED', result);
      return result;
    } else { log('PREVIEW', '填答核验通过，未提交。浏览器标签页保留供检查。'); keepPage = true; return { status: 'preview' }; }
  };

  const runTask = async (chapterId, task, taskKey) => {
    if (task.type === 'work') {
      const result = await runQuiz(chapterId, task);
      if (result) save(taskKey, result);
      return;
    }
    if (task.type !== 'video') throw new Error(`暂不支持任务类型 ${task.type}，附件 ${task.index}`);
    const pendingQuestion = state[taskKey]?.pendingQuestion;
    save(taskKey, { status: 'running', pendingQuestion });
    const playback = {
      rate: Number(options.rate || videoPolicy.rate || config.rate), maxMs: options['max-ms'] || 2400000,
      unknown: options.unknown || 'pause', memory, signal: controller.signal, pendingQuestion,
      acceleration: fastAllowed ? { seek: seekAllowed } : null,
      captureDirectory: file('video-screenshots'),
      onAcceleration: event => log('ACCELERATION', { chapterId, ...event }),
      onProgress: progress => {
        save(taskKey, { status: 'running', ...progress });
        log('PLAYING', { chapterId, t: Math.round(progress.t), duration: progress.duration, rate: progress.rate, reportedRate: progress.reportedRate, elapsed: progress.elapsed });
      },
      onQuestion: (question, updatedMemory) => {
        questions[question.key] = question;
        if (question.result.correct) updatedMemory[question.key] = { ...(updatedMemory[question.key] || updatedMemory[question.q]), verified: true };
        writeJson(file('video-questions.json'), questions); writeJson(file('video-memory.json'), updatedMemory); log('POPUP', question);
      },
    };
    const result = await runVideo(session, course, chapterId, task, {
      playback, ai: !options['no-ai'], context: options.context,
      prepare: (q, context, { signal }) => prepareVideoAnswer(q, context, { vision: !options['no-vision'], cacheFile: file('vision-cache.json'), log, signal }),
      saveMemory: updated => writeJson(file('video-memory.json'), updated), log,
    });
    const heartbeats = session.logs.filter(entry => task.jobId ? entry.jobId === task.jobId : task.objectId && entry.objectId === task.objectId);
    if (result.acceleration?.used && (result.acceleration.fellBack || result.status === 'completed')) {
      videoPolicy.acceleration = { supported: result.acceleration.verified, seekAllowed: result.acceleration.seek?.status === 'blocked' ? false : seekAllowed, reason: result.acceleration.reason, checkedAt: new Date().toISOString() };
      writeJson(file('video-policy.json'), videoPolicy);
    }
    if (result.status === 'completed' && !result.already && (!result.acceleration || result.acceleration.fellBack)) {
      videoPolicy.rate = playback.rate; videoPolicy.verifiedAt = new Date().toISOString();
      writeJson(file('video-policy.json'), videoPolicy);
    }
    save(taskKey, { ...result, rate: playback.rate, heartbeat: heartbeats.at(-1) || null, heartbeats }); log('VIDEO_RESULT', result);
    if (result.status !== 'completed') throw new Error(`视频未完成：${result.status} ${result.reason || ''}`);
  };

  try {
    report('running');
    await platform.openCourse(session.page, course, { log });
    if (command === 'login') { keepPage = true; log('LOGIN_OK'); return; }
    const overview = await platform.readChapters(session.page);
    log('COURSE', { name: course.name, head: overview.head, chapters: overview.items.length });
    if (command === 'status' || command === 'list') {
      log('CHAPTERS', command === 'status' ? overview.items.filter(item => item.pending > 0) : overview.items); return;
    }
    const selectedIds = chapter?.split(',');
    const outstanding = new Set(Object.entries(state).filter(([, value]) => value.pendingQuestion).map(([key]) => key.split(':')[0]));
    const chapters = overview.items.filter(item => selectedIds ? selectedIds.includes(item.id) : options.all || item.pending > 0 || outstanding.has(item.id));
    if (selectedIds && selectedIds.some(id => !chapters.some(item => item.id === id))) throw new Error('指定章节不在课程列表中');
    const scans = [];
    for (const item of chapters) {
      checkAbort(); if (atLimit()) break;
      try {
        await platform.openChapter(session.page, course, item.id);
        if (command === 'inspect') {
          const frames = [];
          for (const frame of session.page.frames()) {
            const url = new URL(frame.url() || 'about:blank');
            frames.push({ path: url.pathname, cardNumber: url.searchParams.get('num'), ...await frame.evaluate(() => ({
              tabs: [...document.querySelectorAll('[onclick*="changeDisplayContent"]')].map(el => ({ text: el.innerText, className: el.className, html: el.outerHTML.slice(0, 500) })),
              text: document.body?.innerText.slice(0, 3500),
              controls: [...document.querySelectorAll('[onclick]')].map(el => ({ tag: el.tagName, text: el.innerText?.slice(0, 80), onclick: el.getAttribute('onclick')?.replace(/enc=[^&'"\s]+/g, 'enc=REDACTED').slice(0, 300) })).slice(0, 60),
              attachmentMetadata: (window.attachments || window.mArg?.attachments || []).map(a => ({ job: a.job, type: a.type, jobId: a.jobid, objectId: a.objectId, name: a.property?.name })),
            })).catch(() => ({})) });
          }
          writeJson(options.output ? path.resolve(options.output) : file(`inspect-${item.id}.json`), frames);
          log('INSPECT', frames.map(({ path, cardNumber, tabs, attachmentMetadata }) => ({ path, cardNumber, tabs, attachmentMetadata }))); touched++; continue;
        }
        if (options.card !== undefined) await platform.selectCard(session.page, options.card);
        const tasks = (await platform.scanAttachments(session.page)).filter(task => options.card === undefined || task.card === options.card);
        reconcileTasks(state, item.id, tasks); saveState();
        scans.push({ ...item, attachments: tasks, pending: tasks.filter(t => t.required && !t.finished) });
        writeJson(file('jobs.json'), scans);
        log('CHAPTER', { id: item.id, name: item.name, attachments: tasks });
        if (command === 'scan') { touched++; }
        else if (['quiz', 'answers', 'solve', 'quizfill', 'harvest', 'redo'].includes(command)) {
          const works = tasks.filter(task => task.type === 'work' && (options['work-index'] === undefined || task.index === options['work-index']));
          if (works.length > 1) throw new Error('本章有多个作业，请指定 --card 与 --work-index');
          await runQuiz(item.id, works[0], command === 'quizfill' ? 'solve' : command); touched++;
        } else if (['works-fill', 'works-extract'].includes(command)) {
          for (const task of tasks.filter(t => t.type === 'work' && (options['work-index'] === undefined || t.index === options['work-index']))) {
            if (atLimit()) break;
            await runQuiz(item.id, task, command); touched++;
          }
        } else {
          for (const task of tasks) {
            checkAbort(); if (atLimit()) break;
            const taskKey = makeTaskKey(item.id, task);
            const pendingQuestion = state[taskKey]?.pendingQuestion;
            if ((task.finished && !pendingQuestion) || (!task.required && !options.all)) continue;
            if (command !== 'run' && task.type !== 'video') continue;
            activeTask = taskKey;
            try {
              await runTask(item.id, task, taskKey);
            } catch (error) {
              if (isFatal(error, controller.signal)) {
                save(taskKey, { ...state[taskKey], status: controller.signal.aborted ? 'interrupted' : 'failed', error: error.message });
                throw error;
              }
              if (state[taskKey]?.status !== 'needs-answer') save(taskKey, { ...state[taskKey], status: 'failed', error: error.message });
              failures.push({ chapterId: item.id, taskKey, error: error.message });
              log('TASK_FAILED', failures.at(-1)); report('running');
            } finally { activeTask = null; touched++; }
            await sleep(config.intervalMs);
          }
          checkAbort();
          const latest = (await platform.scanAttachments(session.page)).filter(task => options.card === undefined || task.card === options.card);
          reconcileTasks(state, item.id, latest); saveState();
          scans[scans.length - 1] = { ...item, attachments: latest, pending: latest.filter(t => t.required && !t.finished) };
          writeJson(file('jobs.json'), scans);
        }
      } catch (error) {
        if (isFatal(error, controller.signal) || !['run', 'video', 'videos'].includes(command)) throw error;
        failures.push({ chapterId: item.id, error: error.message });
        log('CHAPTER_FAILED', failures.at(-1)); report('running');
      }
      if (!atLimit()) await sleep(config.intervalMs);
    }
    if (command === 'scan' && options.output) writeJson(path.resolve(options.output), scans);
    report(failures.length ? 'incomplete' : 'completed');
    log('DONE', { processed: touched, failures, directory });
    if (failures.length) { const error = new Error(`${failures.length} 项异常已记录，其余任务已继续处理；详见 ${reportFile}`); error.code = 'INCOMPLETE'; throw error; }
  } catch (error) {
    keepPage = true;
    if (activeTask) save(activeTask, { ...state[activeTask], status: controller.signal.aborted ? 'interrupted' : 'failed', error: error.message });
    if (error.code !== 'INCOMPLETE') {
      runReport.error = { code: error.code || 'FAILED', message: error.message };
      report(controller.signal.aborted ? 'interrupted' : 'failed');
    }
    log('ERROR', { code: error.code || 'FAILED', message: error.message }); throw error;
  } finally {
    if (runReport.status === 'running') report('completed');
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await session.close({ keepPage });
  }
}

function main(argv) { runCli(argv).catch(error => { console.error(error.message); process.exitCode = 1; }); }
module.exports = { HELP, parseArgs, loadAnswers, runCli, runResolved, main };
