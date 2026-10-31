const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const config = require('../config');
const { extract, buildPlan, fill, submit } = require('../lib/quiz');
const { handlePopup, readState, playVideo, questionKey } = require('../lib/video');
const { scanAttachments } = require('../lib/platform');
const { runVideo } = require('../lib/workflow');
const { recognizeQuiz } = require('../lib/vision');
const { captureQuestion } = require('../lib/vision');
const { runResolved, parseArgs } = require('../lib/runner');
const { courseDirectory, readJson } = require('../lib/store');
const { setPlayback, restorePlayback, seekVideo } = require('../lib/playback');
const { chromium } = require(config.playwright);

(async () => {
  const browser = await chromium.launch({ executablePath: config.chrome, headless: true });
  const screenshots = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-browser-vision-'));
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    const html = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
    await page.setContent(html);
    const qs = await extract(page);
    assert.equal(qs.length, 5); assert.equal(qs[0].opts[0].t, 'Apple');
    const plan = await buildPlan(qs, { answers: { m: ['A', 'C'], j: false, s: 'B', e: '<p>Explicit answer.</p>', b: ['first blank', 'second blank'] } });
    const report = await fill(page, plan);
    assert.ok(report.every(row => row.ok));
    assert.equal(await page.locator('input[name="answerm"]').inputValue(), 'CA');
    assert.equal(await page.locator('input[name="answerj"]').inputValue(), 'false');
    assert.equal(await page.locator('#answerEditorb2').inputValue(), 'second blank');
    console.log('PASS: multi deselection, DOM re-render, judge, essay, complete verification');
    await page.locator('input[name="answerm"]').evaluate(el => { el.value = 'A'; });
    await assert.rejects(() => submit(page, plan), /填答校验失败/);
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    await page.locator('input[name="answerm"]').evaluate(el => { el.value = 'AC'; });
    await page.locator('li[data-key="A"] a').first().evaluate(el => { el.textContent = 'Changed option'; });
    await assert.rejects(() => submit(page, plan), /选项已变化/);
    await page.locator('li[data-key="A"] a').first().evaluate(el => { el.textContent = 'Apple'; });
    const stopSubmit = new AbortController();
    const cancelledSubmission = submit(page, plan, { signal: stopSubmit.signal });
    await page.locator('#confirm .jb_btn').waitFor({ state: 'visible' });
    stopSubmit.abort();
    await assert.rejects(() => cancelledSubmission, /abort/i);
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    console.log('PASS: cancellation before confirmation blocks final submission');
    const result = await submit(page, plan, { timeoutMs: 3000 });
    assert.deepEqual(result, { status: 'graded', score: 100 });
    assert.equal(await page.evaluate(() => window.__submitted), 1);
    console.log('PASS: stale-answer submit blocked; valid submission confirmed with score');
    await page.goto('about:blank');
    await page.setContent(html);
    const newPlan = await buildPlan(await extract(page), { answers: { m: ['A', 'C'], j: false, s: 'B', e: 'Answer', b: ['one', 'two'] } });
    await page.locator('div.singleQuesId').first().evaluate(el => el.remove());
    await assert.rejects(() => fill(page, newPlan), /题目集合/);
    console.log('PASS: missing/replaced question blocks filling');

    await page.goto('about:blank'); await page.setContent(html);
    await page.locator('div.singleQuesId[data="m"] .Zy_TItle').evaluate(el => { el.classList.add('font-cxsecret'); el.innerText = '垪垬垷'; });
    const encrypted = await extract(page);
    const recognized = await recognizeQuiz(page, encrypted, {
      directory: screenshots, cacheFile: path.join(screenshots, 'cache.json'),
      request: async input => {
        assert.equal(input.images.length, 1);
        const png = fs.readFileSync(input.images[0]); assert.equal(png.readUInt32BE(0), 0x89504e47);
        return JSON.stringify({ questions: [{ qid: 'm', readable: true, stem: 'Choose Apple and Cherry', options: [{ key: 'A', text: 'Apple' }, { key: 'B', text: 'Banana' }, { key: 'C', text: 'Cherry' }], visualContext: '' }] });
      },
    });
    let batchCalls = 0;
    const visionPlan = await buildPlan(recognized, { ai: true, answers: { j: false, s: 'B', e: 'Explicit answer', b: ['one', 'two'] }, request: async input => {
      batchCalls++; assert.match(input.prompt, /Choose Apple/); return JSON.stringify({ answers: [{ qid: 'm', answer: ['A', 'C'] }] });
    } });
    assert.equal(batchCalls, 2);
    assert.equal(visionPlan[0].stem, '垪垬垷');
    assert.ok((await fill(page, visionPlan)).every(row => row.ok));
    console.log('PASS: cropped question PNG → recognition → solve → raw DOM verification');

    await page.setContent(`<video muted></video><div class="ans-videoquiz"><div class="tkItem_title">Choose two</div><div class="tkTopic_title">多选</div><ul><li class="ans-videoquiz-opt"><label><input type="checkbox">A、One</label></li><li class="ans-videoquiz-opt"><label><input type="checkbox">B、Two</label></li><li class="ans-videoquiz-opt"><label><input type="checkbox" checked>C、Three</label></li></ul><a id="videoquiz-submit">提交</a><a id="videoquiz-continue">继续</a><span id="spanHas" style="display:none">回答正确</span><span id="spanNot" style="display:none">回答错误</span></div><script>document.querySelector('#videoquiz-submit').onclick=()=>{document.querySelector('#spanHas').style.display='inline'};document.querySelector('#videoquiz-continue').onclick=()=>{document.querySelector('.ans-videoquiz').style.display='none'}</script>`);
    const state = await readState(page);
    assert.equal(state.question.multi, true);
    assert.deepEqual(state.question.opts, ['One', 'Two', 'Three']);
    const popupResult = await handlePopup(page, state.question, [0, 1]);
    assert.equal(popupResult.correct, true); assert.equal(popupResult.action, 'answered');
    assert.deepEqual(await page.locator('input').evaluateAll(inputs => inputs.map(input => input.checked)), [true, true, false]);
    await page.locator('.ans-videoquiz').evaluate(el => { el.style.display = 'block'; el.querySelector('#spanHas').style.display = 'none'; });
    assert.equal((await handlePopup(page, state.question, null, 'pause')).action, 'needs-answer');
    assert.equal((await handlePopup(page, state.question, null, 'skip')).action, 'skipped');
    await page.evaluate(() => {
      document.querySelector('.ans-videoquiz').style.display = 'block';
      document.querySelector('#spanHas').style.display = 'none';
      document.querySelector('#videoquiz-submit').onclick = () => document.querySelector('.ans-videoquiz').remove();
    });
    const autoClose = await handlePopup(page, state.question, [0, 1]);
    assert.equal(autoClose.action, 'submitted'); assert.equal(autoClose.correct, null);
    console.log('PASS: video popup multi-select, unknown pause and explicit skip');

    await page.setContent(`<video muted></video><div class="ans-videoquiz"><div class="tkItem_title">Delayed continue</div><div class="tkTopic_title">判断</div><li class="ans-videoquiz-opt"><input type="radio">A、对</li><li class="ans-videoquiz-opt"><input type="radio">B、错</li><a id="videoquiz-submit">提交</a><a id="videoquiz-continue" style="display:none">继续</a><span id="spanHas" style="display:none">正确</span></div><script>window.submits=0;document.querySelector('#videoquiz-submit').onclick=()=>{window.submits++;document.querySelector('#spanHas').style.display='inline';setTimeout(()=>document.querySelector('#videoquiz-continue').style.display='inline',1200)};document.querySelector('#videoquiz-continue').onclick=()=>{document.querySelector('.ans-videoquiz').style.display='none'}</script>`);
    const delayed = (await readState(page)).question;
    assert.equal((await handlePopup(page, delayed, [0])).action, 'answered');
    assert.equal(await page.evaluate(() => window.submits), 1);
    await page.locator('.ans-videoquiz').evaluate(el => { el.style.display = 'block'; });
    assert.equal((await handlePopup(page, delayed, null)).action, 'answered');
    assert.equal(await page.evaluate(() => window.submits), 1);
    console.log('PASS: delayed continue is awaited; already-correct popup never resubmits');

    await page.locator('.ans-videoquiz').evaluate(el => { el.style.display = 'block'; });
    const firstCapture = await captureQuestion(page, delayed, path.join(screenshots, 'before.png'), { popup: true });
    await page.evaluate(() => { document.querySelectorAll('input')[1].checked = true; document.querySelector('#spanHas').style.display = 'none'; });
    const secondCapture = await captureQuestion(page, delayed, path.join(screenshots, 'after.png'), { popup: true });
    assert.deepEqual(fs.readFileSync(firstCapture), fs.readFileSync(secondCapture));
    console.log('PASS: visual question identity ignores feedback and selected controls');

    // Record a real short local video, then exercise the entire engine in nested frames.
    const webm = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
      const stream = canvas.captureStream(10), chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      recorder.ondataavailable = event => chunks.push(event.data);
      const stopped = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.start();
      const timer = setInterval(() => { const context = canvas.getContext('2d'); context.fillStyle = `hsl(${Date.now()%360},100%,50%)`; context.fillRect(0,0,120,80); }, 100);
      await new Promise(resolve => setTimeout(resolve, 2600)); recorder.stop(); await stopped;
      clearInterval(timer); stream.getTracks().forEach(track => track.stop());
      return await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' })); });
    });
    const pages = {
      '/': `<li class="active" onclick="changeDisplayContent(0)">Video</li><li onclick="changeDisplayContent(1)">Document</li><iframe id="cards" src="https://fixture.test/knowledge/cards"></iframe><script>function changeDisplayContent(index){document.querySelectorAll('li').forEach((li,i)=>li.classList.toggle('active',i===index));document.querySelector('#cards').src='https://fixture.test/knowledge/cards'+(index?'2':'')}</script>`,
      '/knowledge/cards': '<div class="ans-attach-ct videoContainer"><iframe src="https://fixture.test/video"></iframe></div>',
      '/knowledge/cards2': '<div class="ans-attach-ct"><span class="ans-job-icon"></span><iframe src="https://fixture.test/ananas/modules/pdf/index.html"></iframe></div>',
      '/ananas/modules/pdf/index.html': '<p>Document</p>',
      '/mycourse/studentcourse': `<script>window.toOld=()=>top.location='https://fixture.test/mycourse/studentstudy'</script>`,
      '/video': `<video muted src="${webm}"></video><div class="ans-videoquiz" style="display:none"><div class="tkItem_title">Known question</div><div class="tkTopic_title">判断</div><li class="ans-videoquiz-opt"><label><input type="radio" name="q">A、对</label></li><li class="ans-videoquiz-opt"><label><input type="radio" name="q">B、错</label></li><a id="videoquiz-submit">提交</a><a id="videoquiz-continue">继续</a><span id="spanHas" style="display:none">回答正确</span></div><script>const v=document.querySelector('video');let asked=false;v.ontimeupdate=()=>{if(!asked&&v.currentTime>0.4){asked=true;document.querySelector('.ans-videoquiz').style.display='block';v.pause()}};v.onended=()=>parent.document.querySelector('.ans-attach-ct').classList.add('ans-job-finished');document.querySelector('#videoquiz-submit').onclick=()=>document.querySelector('#spanHas').style.display='inline';document.querySelector('#videoquiz-continue').onclick=()=>document.querySelector('.ans-videoquiz').style.display='none';Object.defineProperty(v,'currentTime',{get(){return Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime').get.call(v)},set(){throw new Error('Engine must never seek')}});</script>`,
    };
    pages['/mycourse/studentstudy'] = pages['/'];
    pages['/video'] = pages['/video'].replace('if(!asked&&v.currentTime>0.4)', "if(v.currentTime>0.2)parent.document.querySelector('.ans-attach-ct').classList.add('ans-job-finished');if(!asked&&v.currentTime>0.4)");
    await page.route('https://fixture.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: pages[new URL(route.request().url()).pathname] || '' }));
    await page.route('https://mooc2-ans.chaoxing.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<iframe src="https://fixture.test/mycourse/studentcourse"></iframe>' }));
    await page.goto('https://fixture.test/');
    const tasks = await scanAttachments(page);
    assert.deepEqual(tasks.map(task => [task.card, task.type]), [[0, 'video'], [1, 'document']]);
    const q = { q: 'Known question', opts: ['对', '错'], multi: false };
    const videoResult = await playVideo(page, { index: 0, card: 0 }, { rate: 2, maxMs: 12000, memory: { [questionKey(q)]: { correct: '对' } } });
    assert.equal(videoResult.status, 'completed', JSON.stringify(videoResult)); assert.equal(videoResult.answered, 1);
    assert.equal(videoResult.confirmation, 'online-marker'); assert.equal(videoResult.ended, false);
    const player = page.frames().find(frame => /\/video$/.test(frame.url()));
    assert.equal(await player.evaluate(() => document.querySelector('video').paused), true);
    console.log('PASS: real video in nested iframes, cached popup answer, completion marker, no seeking');
    await player.evaluate(() => {
      document.querySelector('.ans-videoquiz').style.display = 'block';
      document.querySelector('#spanHas').style.display = 'none';
    });
    const completedWithPopup = await playVideo(page, { index: 0, card: 0 }, { rate: 2, maxMs: 12000, memory: { [questionKey(q)]: { correct: '对' } } });
    assert.equal(completedWithPopup.answered, 1); assert.equal(completedWithPopup.already, undefined);
    console.log('PASS: a visible popup is handled even when task was already marked completed');

    const popupVideo = pages['/video'];
    pages['/video'] = `<video muted loop src="${webm}"></video><script>const v=document.querySelector('video');v.ontimeupdate=()=>{if(v.currentTime>0.2)parent.document.querySelector('.ans-attach-ct').classList.add('ans-job-finished')}</script>`;
    await page.goto('https://fixture.test/mycourse/studentstudy');
    const early = await playVideo(page, { index: 0, card: 0 }, { rate: 2, maxMs: 5000 });
    assert.equal(early.status, 'completed'); assert.equal(early.confirmation, 'online-marker'); assert.equal(early.ended, false);
    assert.ok(early.t < early.duration);
    assert.equal(await page.frames().find(frame => /\/video$/.test(frame.url())).evaluate(() => document.querySelector('video').paused), true);
    console.log('PASS: early platform completion stops and pauses a video without waiting for ended');
    pages['/video'] = popupVideo;
    pages['/video'] = pages['/video'].replace('<div class="tkItem_title">Known question</div>', '<div class="tkItem_title">Known question<img width="20" height="20" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII="></div>');
    await page.goto('https://fixture.test/mycourse/studentstudy');
    let prepared = 0, saved = 0;
    const automatic = await runVideo({ page, logs: [] }, { courseId: 1, clazzId: 2, cpi: 3, enc: 'fixture' }, '123', { index: 0, card: 0 }, {
      playback: { rate: 2, maxMs: 12000, memory: {}, captureDirectory: screenshots },
      prepare: async question => {
        assert.match(page.url(), /fixture.test\/mycourse\/studentstudy/);
        const video = page.frames().find(frame => /\/video$/.test(frame.url()));
        assert.equal(await video.evaluate(() => document.querySelector('video').paused), true);
        await new Promise(resolve => setTimeout(resolve, 800));
        assert.equal(question.q, 'Known question'); prepared++;
        assert.equal(question.needsVisual, true); assert.ok(fs.existsSync(question.imagePath)); assert.ok(question.visualHash);
        return { correct: '对', picks: [0], verified: false, source: 'offline-stub' };
      },
      saveMemory: memory => { assert.equal(prepared, 1); assert.equal(Object.keys(memory).length, 1); saved++; },
    });
    assert.equal(automatic.status, 'completed', JSON.stringify(automatic));
    assert.equal(prepared, 1); assert.equal(saved, 1);
    assert.equal(automatic.answered, 1);
    assert.equal(automatic.confirmation, 'online-marker'); assert.equal(automatic.ended, false);
    console.log('PASS: visible popup with green marker → pause in place → AI/cache → answer → early completion');

    // Repeat a platform-rejected answer with fresh reasoning, never enumerate combinations.
    pages['/video'] = pages['/video'].replace(/<img[^>]+>/, '').replace('<span id="spanHas"', '<span id="spanNot" style="display:none">错误</span><span id="spanHas"').replace("document.querySelector('#videoquiz-submit').onclick=()=>document.querySelector('#spanHas').style.display='inline'", "document.querySelector('#videoquiz-submit').onclick=()=>{const correct=document.querySelectorAll('input')[1].checked;document.querySelector('#spanHas').style.display=correct?'inline':'none';document.querySelector('#spanNot').style.display=correct?'none':'inline'}");
    await page.goto('https://fixture.test/mycourse/studentstudy');
    const memory = { [questionKey(q)]: { correct: ['对'] } };
    let corrections = 0;
    const corrected = await runVideo({ page, logs: [] }, {}, '123', { index: 0, card: 0 }, {
      playback: { rate: 2, maxMs: 12000, memory },
      prepare: async question => { assert.deepEqual(question.tried, [['对']]); corrections++; return { correct: ['错'] }; },
    });
    assert.equal(corrected.status, 'completed', JSON.stringify(corrected));
    assert.equal(corrections, 1); assert.equal(memory[questionKey(q)].verified, true);
    assert.deepEqual(memory[questionKey(q)].tried, [['对']]);
    console.log('PASS: platform rejects cached answer → invalidation → AI correction → verified completion');

    await page.goto('https://fixture.test/mycourse/studentstudy');
    const outstanding = await playVideo(page, { index: 0, card: 0 }, { rate: 2, maxMs: 12000, memory, pendingQuestion: 'missing-popup' });
    assert.equal(outstanding.status, 'needs-answer'); assert.match(outstanding.reason, /未再次出现/);
    console.log('PASS: outstanding tail question prevents false completion');

    // The media clock runs at 16 while an instance read and reset see one.
    await page.goto('about:blank');
    await page.setContent(`<video muted src="${webm}"></video><script>const v=document.querySelector('video');v.onratechange=()=>{if(v.playbackRate!==1)v.playbackRate=1}</script>`);
    await setPlayback(page, { shadow: true });
    await page.evaluate(() => document.querySelector('video').play());
    await page.evaluate(() => { document.querySelector('video').playbackRate = 1; });
    await page.waitForTimeout(250);
    const shadow = await readState(page);
    assert.equal(shadow.rate, 16); assert.equal(shadow.reportedRate, 1); assert.ok(shadow.t > 1);
    await page.evaluate(() => document.querySelector('video').pause());
    await restorePlayback(page);
    assert.equal(await page.evaluate(() => Object.hasOwn(document.querySelector('video'), 'playbackRate')), false);
    assert.equal((await readState(page)).rate, 1);
    console.log('PASS: native 16x media clock, shadow getter/reset at 1x, original property restored');

    await page.goto('about:blank'); await page.setContent(`<video muted preload="auto" src="${webm}"></video>`);
    await page.evaluate(() => document.querySelector('video').play());
    const seek = await seekVideo(page, 0.9, { settleMs: 150 });
    assert.equal(seek.status, 'accepted');
    await page.evaluate(() => { const v=document.querySelector('video');v.addEventListener('seeking',()=>{if(v.currentTime>0.5){v.currentTime=0;v.pause()}});v.currentTime=0; });
    const blockedSeek = await seekVideo(page, 0.9, { settleMs: 150 });
    assert.equal(blockedSeek.status, 'blocked'); assert.ok(blockedSeek.to < blockedSeek.target);
    console.log('PASS: seek to 90% is observed; front-end rewind is detected rather than bypassed');

    // A permissive player verifies acceleration; cleanup pauses and removes the shadow.
    const originalVideo = pages['/video'];
    pages['/video'] = `<video muted src="${webm}"></video><script>const v=document.querySelector('video');v.onended=()=>parent.document.querySelector('.ans-attach-ct').classList.add('ans-job-finished')</script>`;
    await page.goto('https://fixture.test/mycourse/studentstudy');
    const speedEvents = [];
    const fastResult = await runVideo({ page, logs: [] }, {}, '9', { index: 0, card: 0 }, { playback: { rate: 2, memory: {}, maxMs: 12000, acceleration: { seek: true }, onAcceleration: event => speedEvents.push(event) } });
    assert.equal(fastResult.status, 'completed'); assert.equal(fastResult.acceleration.verified, true);
    assert.equal(fastResult.acceleration.seek.status, 'accepted');
    assert.deepEqual(speedEvents.map(event => event.action), ['seek-probe', 'shadow-16']);
    assert.equal(speedEvents[0].actualRate, 2); assert.equal(speedEvents[1].actualRate, 16);
    const fastPlayer = page.frames().find(frame => /\/video$/.test(frame.url()));
    assert.equal(await fastPlayer.evaluate(() => Object.hasOwn(document.querySelector('video'), 'playbackRate')), false);
    assert.equal((await readState(fastPlayer)).paused, true);
    console.log('PASS: 90% seek + shadow 16x + platform completion + cleanup');

    pages['/video'] = originalVideo;
    await page.goto('https://fixture.test/mycourse/studentstudy');
    const blockedEvents = [];
    const seekBlockedFast = await runVideo({ page, logs: [] }, {}, '9', { index: 0, card: 0 }, {
      playback: { rate: 2, memory, maxMs: 15000, acceleration: { seek: true }, onAcceleration: event => blockedEvents.push(event) },
      wait: async () => {}, openChapter: async () => page.goto('https://fixture.test/mycourse/studentstudy'),
    });
    assert.equal(seekBlockedFast.status, 'completed'); assert.equal(seekBlockedFast.acceleration.seek.status, 'blocked');
    assert.equal(seekBlockedFast.acceleration.verified, false); assert.equal(seekBlockedFast.acceleration.fellBack, true);
    assert.equal(seekBlockedFast.actualRate, 2); assert.ok(blockedEvents.every(event => event.action !== 'shadow-16'));
    console.log('PASS: blocked forward seek never enables 16x and falls back to normal 2x');

    pages['/video'] = `<video muted loop src="${webm}"></video>`;
    await page.goto('https://fixture.test/mycourse/studentstudy');
    const stopFast = new AbortController();
    await assert.rejects(() => playVideo(page, { index: 0, card: 0 }, {
      rate: 2, maxMs: 5000, acceleration: { seek: false }, signal: stopFast.signal, onProgress: () => stopFast.abort(),
    }), /中断|abort/i);
    const stoppedFastPlayer = page.frames().find(frame => /\/video$/.test(frame.url()));
    assert.equal(await stoppedFastPlayer.evaluate(() => Object.hasOwn(document.querySelector('video'), 'playbackRate')), false);
    assert.equal((await readState(stoppedFastPlayer)).paused, true);
    console.log('PASS: interruption pauses accelerated video and removes its shadow property');

    // A strict fixture refuses fast completion and requires a normal replay from zero.
    pages['/video'] = `<video muted src="${webm}"></video><script>const v=document.querySelector('video');let restarted=false;v.onloadedmetadata=()=>v.currentTime=v.duration*0.6;v.onseeking=()=>{if(v.currentTime<0.1)restarted=true};v.onended=()=>{if(restarted&&Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'playbackRate').get.call(v)<=2)parent.document.querySelector('.ans-attach-ct').classList.add('ans-job-finished')}</script>`;
    await page.goto('https://fixture.test/mycourse/studentstudy');
    const fallbackResult = await runVideo({ page, logs: [] }, {}, '9', { index: 0, card: 0 }, {
      playback: { rate: 2, memory: {}, maxMs: 30000, acceleration: { seek: true } },
      confirm: async () => false, wait: async () => {}, openChapter: async () => page.goto('https://fixture.test/mycourse/studentstudy'),
    });
    assert.equal(fallbackResult.status, 'completed', JSON.stringify(fallbackResult)); assert.equal(fallbackResult.acceleration.fellBack, true);
    assert.equal(fallbackResult.actualRate, 2); assert.equal(fallbackResult.acceleration.verified, false);
    console.log('PASS: unconfirmed 16x → fresh page → restart from zero → real normal-speed completion');
    pages['/video'] = originalVideo;

    // Exercise the actual CLI orchestration against two offline chapters.
    const course = { courseId: '9001', clazzId: '9002', cpi: '9003', enc: 'fixture' };
    const oldData = config.data, oldInterval = config.intervalMs;
    try {
      config.data = path.join(screenshots, 'queue-data'); config.intervalMs = 0;
      pages['/mycourse/studentcourse'] = '<div class="chapter_head">Fixture</div><div class="chapter_item" id="cur1"><span class="catalog_name">Bad</span><span class="catalog_points_yi">1</span></div><div class="chapter_item" id="cur2"><span class="catalog_name">Good</span><span class="catalog_points_yi">1</span></div><script>window.toOld=(c,id)=>top.location="https://fixture.test/mycourse/studentstudy?chapterId="+id</script>';
      await page.route('https://fixture.test/mycourse/studentstudy*', route => {
        const id = new URL(route.request().url()).searchParams.get('chapterId');
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<iframe src="https://fixture.test/knowledge/cards?chapter=${id}"></iframe>` });
      });
      await page.route('https://fixture.test/knowledge/cards?*', route => {
        const id = new URL(route.request().url()).searchParams.get('chapter');
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div class="ans-attach-ct videoContainer"><span class="ans-job-icon"></span><iframe src="https://fixture.test/queue-video?chapter=${id}"></iframe></div>` });
      });
      let accelerationQueue = false;
      await page.route('https://fixture.test/queue-video?*', route => {
        const good = new URL(route.request().url()).searchParams.get('chapter') === '2';
        const body = good ? `<video muted src="${webm}"></video><script>document.querySelector('video').onended=()=>parent.document.querySelector('.ans-attach-ct').classList.add('ans-job-finished')</script>` : accelerationQueue
          ? `<video muted src="${webm}"></video><script>const v=document.querySelector('video');v.onseeking=()=>{if(v.currentTime>v.duration*0.8){v.currentTime=0;v.pause()}};v.onended=()=>parent.document.querySelector('.ans-attach-ct').classList.add('ans-job-finished')</script>`
          : pages['/video'].replace("if(v.currentTime>0.2)parent.document.querySelector('.ans-attach-ct').classList.add('ans-job-finished');", '');
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
      });
      await assert.rejects(() => runResolved(parseArgs(['run', 'fixture', '1,2', '--no-ai']), course, { connect: async () => ({ page, logs: [], close: async () => {} }) }), error => error.code === 'INCOMPLETE');
      const directory = courseDirectory(course), report = readJson(path.join(directory, 'run-report.json'));
      assert.equal(report.status, 'incomplete'); assert.equal(report.failures.length, 1); assert.equal(report.processed, 2);
      const state = readJson(path.join(directory, 'tasks.json'));
      assert.equal(state['1:0:video:0'].status, 'needs-answer');
      assert.equal(state['2:0:video:0'].status, 'completed');
      console.log('PASS: CLI records failing first task, completes next chapter, reconciles state, exits INCOMPLETE');
      accelerationQueue = true;
      config.data = path.join(screenshots, 'per-video-probe');
      await runResolved(parseArgs(['run', 'fixture', '1,2', '--no-ai', '--accelerate', '--rate', '2']), course, { connect: async () => ({ page, logs: [], close: async () => {} }) });
      const acceleratedState = readJson(path.join(courseDirectory(course), 'tasks.json'));
      assert.equal(acceleratedState['1:0:video:0'].acceleration.seek.status, 'blocked');
      assert.equal(acceleratedState['1:0:video:0'].actualRate, 2);
      assert.equal(acceleratedState['2:0:video:0'].acceleration.seek.status, 'accepted');
      assert.equal(acceleratedState['2:0:video:0'].acceleration.verified, true);
      console.log('PASS: first video rejects seeking and uses 2x; next video still probes and completes at 16x');
    } finally { config.data = oldData; config.intervalMs = oldInterval; }
  } finally { await browser.close(); fs.rmSync(screenshots, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
