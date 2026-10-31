const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAnswer, consensus, askLLM, askBlanks } = require('../lib/answer');
const { buildPlan, assertPlan, assertReport } = require('../lib/quiz');
const { readJson, writeJson, acquireLock, courseDirectory } = require('../lib/store');
const { resolveCourse, courseUrl } = require('../lib/course');
const { classifyPage } = require('../lib/browser');
const { parseArgs } = require('../lib/runner');
const { memoryAnswer, questionKey } = require('../lib/video');

const single = { qid: '1', stem: 'example', type: '单选', opts: [{ k: 'A', t: 'Apple' }, { k: 'B', t: 'Banana' }, { k: 'C', t: 'Cherry' }] };
const multi = { ...single, type: '多选' };
const judge = { ...single, type: '判断', opts: [{ k: 'false', t: '错' }, { k: 'true', t: '对' }] };

test('strict answer parsing rejects English prose and invalid options', () => {
  assert.deepEqual(parseAnswer('答案：B', single), ['B']);
  assert.deepEqual(parseAnswer('a,c', multi), ['A', 'C']);
  assert.deepEqual(parseAnswer('["A", "C"]', multi), ['A', 'C']);
  assert.equal(parseAnswer('The answer is B because...', single), null);
  assert.equal(parseAnswer('AB', single), null);
  assert.equal(parseAnswer('Z', multi), null);
});

test('judge maps letters by actual option order; supports True/False and Chinese', () => {
  for (const text of ['false', '错', 'A', 'F']) assert.deepEqual(parseAnswer(text, judge), ['false']);
  for (const text of ['true', '对', 'B', 'T']) assert.deepEqual(parseAnswer(text, judge), ['true']);
  assert.equal(parseAnswer('大概正确，但不确定', judge), null);
});

test('votes require a real majority and never invent a zero-vote judgment', () => {
  assert.equal(consensus([], judge).keys, null);
  assert.equal(consensus(['invalid', 'invalid'], judge).keys, null);
  assert.equal(consensus(['A', 'B'], judge).keys, null);
  assert.deepEqual(consensus(['AC', 'ABC', 'AC'], multi).keys, ['A', 'C']);
  assert.equal(consensus(['A', 'B', 'C'], single).keys, null);
  assert.equal(consensus(['A'], single).keys, null);
});

test('AI errors and malformed responses produce unresolved plans', async () => {
  const request = async () => { throw new Error('offline'); };
  const result = await askLLM(judge, { request });
  assert.equal(result.keys, null); assert.equal(result.errors.length, 3);
  const plan = await buildPlan([judge], { ai: true, request });
  assert.throws(() => assertPlan(plan));
});

test('generic AI prompt honors context and can settle an initial tie', async () => {
  const outputs = ['A', 'B', 'C', 'B'];
  const request = async input => { assert.match(input.prompt, /会计/); return outputs.shift(); };
  const result = await askLLM(single, { request, context: '会计' });
  assert.equal(result.keys, null); // 2/4 is not a majority.
  assert.equal(result.samples.length, 4);
});

test('planning accepts qid answers, checks cardinality and does not auto-generate essays', async () => {
  const plan = await buildPlan([multi, { ...judge, qid: '2' }], { answers: { '1': ['A', 'C'], '2': false } });
  assertPlan(plan);
  assert.deepEqual(plan[1].keys, ['false']);
  const essay = { qid: '3', type: '简答', stem: 'Explain', opts: [] };
  assert.throws(() => assertPlan([{ qid: '3', kind: 'text', text: '<p> </p>' }]));
  const textPlan = await buildPlan([essay], { answers: { '3': '<p>Explicit answer</p>' } });
  assertPlan(textPlan);
  assert.throws(() => assertPlan([{ ...plan[1], keys: ['A'] }]));
  await assert.rejects(() => buildPlan([]), /没有题目/);
  await assert.rejects(() => buildPlan([single, single]), /重复/);
});

test('submission report rejects empty, incomplete, duplicated and failed rows', async () => {
  const plan = await buildPlan([single], { answers: { '1': ['A'] } });
  assert.throws(() => assertReport([], plan));
  assert.throws(() => assertReport([{ qid: '1', ok: false }], plan));
  assert.throws(() => assertReport([{ qid: 'wrong', ok: true }], plan));
  assert.throws(() => assertReport([{ qid: '1', ok: true }], []));
  assertReport([{ qid: '1', ok: true }], plan);
});

test('multiple blanks require all fields, and AI needs two identical structured samples', async () => {
  const question = { qid: 'b', type: '填空', stem: '( ), ( )', opts: [], fields: ['answerEditorb1', 'answerEditorb2'] };
  assertPlan(await buildPlan([question], { answers: { b: ['one', 'two'] } }));
  const incomplete = await buildPlan([question], { answers: { b: ['one'] } });
  assert.throws(() => assertPlan(incomplete));
  const outputs = ['["one","two"]', '["one","two"]', '["other","two"]'];
  assert.deepEqual((await askBlanks(question, { request: async () => outputs.shift() })).texts, ['one', 'two']);
  const missing = await askBlanks(question, { request: async () => '["one"]' });
  assert.match(missing.error, /未形成/);
});

test('encrypted fonts block AI but permit an explicit supplied answer', async () => {
  const q = { ...single, encrypted: true };
  const plan = await buildPlan([q], { ai: true, request: () => assert.fail('should not call AI') });
  assert.throws(() => assertPlan(plan), /加密字体/);
  assertPlan(await buildPlan([q], { answers: { '1': 'B' } }));
  const visual = await buildPlan([{ ...single, needsVisual: true }], { ai: true, request: () => assert.fail('should not call AI') });
  assert.throws(() => assertPlan(visual), /图片/);
});

test('atomic state round trips; corrupt files fail instead of silently restarting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-store-test-'));
  try {
    const file = path.join(dir, 'state.json');
    assert.deepEqual(readJson(file, {}), {});
    writeJson(file, { done: 1 }); writeJson(file, { done: 2 });
    assert.deepEqual(readJson(file), { done: 2 });
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
    fs.writeFileSync(file, '{'); assert.throws(() => readJson(file, {}), /无法读取/);
    assert.notEqual(courseDirectory({ courseId: 1, clazzId: 2, cpi: 3 }), courseDirectory({ courseId: 1, clazzId: 2, cpi: 4 }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lock refuses active owners and releases partial acquisitions after failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-lock-test-'));
  try {
    const release = acquireLock(['b'], dir);
    assert.throws(() => acquireLock(['a', 'b'], dir), /正在被进程/);
    assert.equal(fs.readdirSync(dir).length, 1);
    release(); release();
    const next = acquireLock(['a', 'b'], dir); next();
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('course URLs support mixed parameter case and reject missing identity', () => {
  const course = resolveCourse('https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=123&clazzid=456&cpi=789&enc=abc');
  assert.equal(new URL(courseUrl(course)).searchParams.get('courseid'), '123');
  assert.throws(() => resolveCourse('https://example.com/?courseid=1'), /chaoxing/);
  assert.throws(() => resolveCourse('https://mooc1.chaoxing.com/?courseid=1'), /clazzId/);
});

test('login SMS text is not mistaken for an anti-spider challenge', () => {
  assert.equal(classifyPage('https://passport2.chaoxing.com/login', '获取验证码'), 'LOGIN');
  assert.equal(classifyPage('https://mooc1.chaoxing.com/antispiderShowVerify.ac'), 'CAPTCHA');
  assert.equal(classifyPage('https://mooc1.chaoxing.com/mycourse/studentstudy', 'enc校验失败'), 'ENC_EXPIRED');
  assert.equal(classifyPage('https://mooc1.chaoxing.com/mycourse/studentstudy', '账号已锁定'), 'ACCOUNT_LOCKED');
});

test('CLI validates rates, bounds, missing values and unknown options before browsing', () => {
  assert.equal(parseArgs(['video', 'c3', '123', '--rate=1.5']).options.rate, '1.5');
  for (const argv of [['videos', 'c3', '--rate', '16'], ['scan', 'c3', '--limit', '0'], ['solve', 'c3', '--answers'], ['video', 'c3', '--unknown', 'try'], ['status', 'c3', '--parallel', '3']]) assert.throws(() => parseArgs(argv));
});

test('video memory is text based, order independent, and supports multiple choices', () => {
  const q = { q: 'Choose', opts: ['A text', 'B text', 'C text'], multi: true };
  const key = questionKey(q), memory = { [key]: { correct: ['A text', 'C text'] } };
  assert.deepEqual(memoryAnswer(q, memory), [0, 2]);
  const reordered = { ...q, opts: ['C text', 'A text', 'B text'] };
  assert.equal(questionKey(reordered), key);
  assert.deepEqual(memoryAnswer(reordered, memory), [1, 0]);
  assert.equal(memoryAnswer({ ...q, multi: false }, memory), null);
  assert.equal(memoryAnswer({ ...q, opts: ['other'] }, memory), null);
});
