const config = require('../config');
const { courseUrl } = require('./course');
const { sleep, assertPage, classifyPage, PageError } = require('./browser');

async function waitFrame(page, pattern, timeout = config.timeoutMs) {
  const deadline = Date.now() + timeout;
  do {
    await assertPage(page);
    const frame = page.frames().find(f => pattern.test(f.url()));
    if (frame) return frame;
    await sleep(400);
  } while (Date.now() < deadline);
  throw new PageError('FRAME_MISSING', `等待 iframe 超时：${pattern}`);
}

async function openCourse(page, course, { waitLogin = true, log = console.log } = {}) {
  await page.goto(courseUrl(course), { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
  if (classifyPage(page.url()) === 'LOGIN' && waitLogin) {
    log('请在打开的 Chrome 中登录；脚本等待登录，不刷新二维码。');
    const deadline = Date.now() + config.loginTimeoutMs;
    while (classifyPage(page.url()) === 'LOGIN' && Date.now() < deadline) await sleep(1000);
    // Login redirects may land on the personal homepage instead of the requested course.
    if (classifyPage(page.url()) !== 'LOGIN') await page.goto(courseUrl(course), { waitUntil: 'domcontentloaded' });
  }
  await assertPage(page);
  return waitFrame(page, /\/mycourse\/studentcourse/);
}

async function readChapters(page) {
  const frame = await waitFrame(page, /\/mycourse\/studentcourse/);
  return frame.evaluate(() => ({
    title: document.title,
    head: document.querySelector('.chapter_head')?.innerText.trim() || '',
    items: [...document.querySelectorAll('.chapter_item[id]')].map(el => ({
      id: el.id.replace(/^cur/, ''),
      name: (el.querySelector('.catalog_name')?.innerText || '').replace(/\s+/g, ' ').trim(),
      pending: Number(el.querySelector('.catalog_points_yi')?.innerText || 0),
    })),
  }));
}

async function openChapter(page, course, chapterId) {
  if (!/^\d+$/.test(String(chapterId))) throw new Error('章节 ID 必须是数字');
  // Always obtain fresh signed navigation through the course's own function.
  // No shared studyEnc assembled into guessed URLs.
  for (let attempt = 0; attempt < 2; attempt++) {
    const frame = await openCourse(page, course);
    await frame.evaluate(({ courseId, clazzId, chapterId }) => {
      if (typeof window.toOld !== 'function') throw new Error('页面缺少 toOld 导航函数');
      window.isToOldLink = false;
      window.toOld(courseId, chapterId, clazzId, 0);
    }, { courseId: course.courseId, clazzId: course.clazzId, chapterId });
    try {
      await page.waitForURL(url => /\/mycourse\/studentstudy/.test(url.pathname) || classifyPage(url.href), { timeout: config.timeoutMs });
      await assertPage(page);
      const cards = await waitFrame(page, /\/knowledge\/cards/);
      return cards;
    } catch (error) {
      if (error.code !== 'ENC_EXPIRED' || attempt) throw error;
    }
  }
}

async function readAttachments(page) {
  const cards = await waitFrame(page, /\/knowledge\/cards/);
  await cards.waitForSelector('.ans-attach-ct', { state: 'attached', timeout: config.timeoutMs }).catch(() => {});
  await assertPage(page);
  return cards.evaluate(() => {
    const attachments = window.attachments || window.mArg?.attachments || [];
    return [...document.querySelectorAll('.ans-attach-ct')].map((el, index) => {
      const iframe = el.querySelector('iframe');
      let data = {};
      try { data = JSON.parse(iframe?.getAttribute('data') || '{}'); } catch {}
      const objectId = data.objectid || data.objectId || iframe?.getAttribute('objectid') || '';
      const attachment = (objectId ? attachments.find(a => String(a.objectId || a.property?.objectid || '') === String(objectId)) : null)
        || (data._jobid ? attachments.find(a => String(a.jobid) === String(data._jobid)) : null) || attachments[index] || {};
      const src = iframe?.getAttribute('src') || '';
      const type = /modules\/video\//.test(src) || el.classList.contains('videoContainer') ? 'video'
        : /modules\/work\//.test(src) ? 'work'
          : /modules\/(pdf|doc|office|insertdoc)\//.test(src) ? 'document' : 'unknown';
      return {
        index, type, objectId: String(objectId || attachment.objectId || attachment.property?.objectid || ''),
        jobId: String(attachment.jobid || data._jobid || data.jobid || ''),
        title: attachment.property?.name || data.name || iframe?.getAttribute('title') || '',
        required: Boolean(attachment.job || el.querySelector('.ans-job-icon') || el.classList.contains('ans-job-finished')),
        finished: el.classList.contains('ans-job-finished'),
      };
    });
  });
}

async function readCards(page) {
  const cards = await page.evaluate(() => [...document.querySelectorAll('[onclick*="changeDisplayContent"]')].map((el, index) => ({ index, title: el.innerText.trim(), active: el.classList.contains('active') })));
  return cards.length ? cards : [{ index: 0, title: '', active: true }];
}

async function selectCard(page, index) {
  if (!Number.isInteger(index) || index < 0) throw new Error('卡片序号必须为非负整数');
  const tabs = await readCards(page);
  const tab = tabs.find(item => item.index === index);
  if (!tab) throw new Error(`本章没有卡片 ${index}`);
  if (tab.active) return;
  const navigation = page.waitForEvent('framenavigated', { predicate: frame => /\/knowledge\/cards/.test(frame.url()), timeout: config.timeoutMs });
  await Promise.all([navigation, page.locator('[onclick*="changeDisplayContent"]').nth(index).click()]);
  await waitFrame(page, /\/knowledge\/cards/);
}

async function scanAttachments(page) {
  const tasks = [];
  for (const card of await readCards(page)) {
    await selectCard(page, card.index);
    tasks.push(...(await readAttachments(page)).map(task => ({ ...task, card: card.index, cardTitle: card.title })));
    if ((await readCards(page)).length > 1) await sleep(1000);
  }
  return tasks;
}

async function attachmentFrame(page, task) {
  if (task.card !== undefined) await selectCard(page, task.card);
  const cards = await waitFrame(page, /\/knowledge\/cards/);
  const container = cards.locator('.ans-attach-ct').nth(task.index);
  await container.scrollIntoViewIfNeeded();
  const handle = await container.locator('iframe').elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new PageError('FRAME_MISSING', `附件 ${task.index} 没有 iframe`);
  return { frame, container };
}

async function quizDoc(page, { openWork = true, workIndex, card } = {}) {
  if (card !== undefined) await selectCard(page, card);
  let root;
  const find = async () => {
    for (const frame of page.frames()) {
      if (root) {
        let ancestor = frame;
        while (ancestor && ancestor !== root) ancestor = ancestor.parentFrame();
        if (!ancestor) continue;
      }
      try { if (await frame.locator('div.singleQuesId').count()) return frame; } catch {}
    }
    return null;
  };
  let found = await find();
  if (openWork) {
    const tasks = await readAttachments(page);
    const works = tasks.filter(t => t.type === 'work');
    if (workIndex === undefined && works.length > 1) throw new Error('本章有多个作业附件，请使用 --work-index 指定附件序号');
    const task = workIndex === undefined ? works[0] : works.find(t => t.index === Number(workIndex));
    if (workIndex !== undefined && !task) throw new Error(`当前卡片不存在作业附件 ${workIndex}`);
    if (task) {
      const cards = await waitFrame(page, /\/knowledge\/cards/);
      const container = cards.locator('.ans-attach-ct').nth(task.index);
      await container.scrollIntoViewIfNeeded();
      await container.click({ force: true });
      root = (await attachmentFrame(page, task)).frame;
    }
  }
  if (found && !root) return found;
  const deadline = Date.now() + config.timeoutMs;
  while (Date.now() < deadline) {
    await assertPage(page);
    found = await find(); if (found) return found;
    await sleep(500);
  }
  throw new PageError('QUIZ_MISSING', '该章节没有可读取的测验表单');
}

module.exports = { openCourse, readChapters, openChapter, readCards, selectCard, readAttachments, scanAttachments, attachmentFrame, quizDoc, waitFrame };
