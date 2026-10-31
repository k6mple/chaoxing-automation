const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseRecognition, recognize } = require('../lib/vision');
const { buildPlan, assertPlan } = require('../lib/quiz');
const { complete, loadVisionKey } = require('../lib/ai');
const { memoryAnswer, questionKey } = require('../lib/video');
const config = require('../config');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
const question = { qid: 'q1', type: '单选', stem: '垪垬垷', encrypted: true, opts: [{ k: 'A', t: '垷' }, { k: 'B', t: '垪' }] };
const row = { qid: 'q1', readable: true, stem: 'Which option?', options: [{ key: 'A', text: 'First' }, { key: 'B', text: 'Second' }], visualContext: '' };
const response = input => JSON.stringify({ questions: input });

test('vision requires exact identity, readability and option order', () => {
  assert.equal(parseRecognition(response([row]), [question])[0].stem, 'Which option?');
  for (const rows of [[], [row, row], [{ ...row, qid: 'other' }], [{ ...row, readable: false }], [{ ...row, options: [...row.options].reverse() }]]) assert.throws(() => parseRecognition(response(rows), [question]));
  assert.throws(() => parseRecognition('invalid', [question]), /JSON/);
  assert.throws(() => parseRecognition('null', [question]), /题目集合/);
  assert.throws(() => parseRecognition(response([null]), [question]), /识图未能/);
  assert.throws(() => parseRecognition(response([row]), [{ ...question, needsVisual: true }]), /图片内容/);
});

test('recognition caching avoids duplicate calls and is scoped by image, model and endpoint', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-vision-test-'));
  try {
    const imagePath = path.join(directory, 'q.png'), cacheFile = path.join(directory, 'cache.json'); fs.writeFileSync(imagePath, png);
    let calls = 0;
    const request = async input => { calls++; assert.deepEqual(input.images, [imagePath]); return response([row]); };
    const input = [{ ...question, imagePath }], options = { cacheFile, request, model: 'test-v1', apiBase: 'https://test.invalid' };
    await recognize(input, options); await recognize(input, options); assert.equal(calls, 1);
    await recognize(input, { ...options, model: 'test-v2' }); assert.equal(calls, 2);
    await recognize(input, { ...options, apiBase: 'https://other.invalid' }); assert.equal(calls, 3);
    fs.appendFileSync(imagePath, Buffer.from([0])); await recognize(input, options); assert.equal(calls, 4);
    await assert.rejects(() => recognize([{ ...question }], options), /缺少题目截图/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('recognized text is used for solving while raw DOM stays intact for verification', async () => {
  const recognition = parseRecognition(response([row]), [question])[0];
  const plan = await buildPlan([{ ...question, recognition }], { ai: true, strategy: 'legacy', request: async input => {
    assert.match(input.prompt, /Which option/); assert.doesNotMatch(input.prompt, /垪垬/); return 'B';
  } });
  assertPlan(plan); assert.equal(plan[0].stem, question.stem); assert.deepEqual(plan[0].opts, question.opts);
  assert.deepEqual(plan[0].keys, ['B']); assert.equal(plan[0].source, 'vision-ai');
});

test('diagram solving includes original screenshot on every answer sample', async () => {
  const recognition = { ...parseRecognition(response([row]), [question])[0], visualContext: 'A chart with two bars.' };
  let calls = 0;
  const plan = await buildPlan([{ ...question, needsVisual: true, recognition, imagePath: '/local/diagram.png' }], {
    ai: true, strategy: 'legacy', request: () => assert.fail('diagram must use a vision request'),
    visionRequest: async input => { calls++; assert.deepEqual(input.images, ['/local/diagram.png']); assert.match(input.prompt, /two bars/); return 'A'; },
  });
  assertPlan(plan); assert.equal(calls, 3); assert.deepEqual(plan[0].keys, ['A']);
});

test('image completion uses user image blocks and never embeds credentials in the prompt', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-image-payload-'));
  try {
    const file = path.join(directory, 'q.png'); fs.writeFileSync(file, png);
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(url, 'https://fixture.invalid/chat/completions'); assert.equal(body.model, 'vision-test');
      assert.equal(init.headers.Authorization, 'Bearer unit-only-key');
      assert.equal(body.messages[0].content, 'rules'); assert.equal(body.messages[1].content[0].text, 'Read this');
      assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
      assert.equal(body.response_format.type, 'json_object'); assert.ok(!init.body.includes('unit-only-key'));
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
    });
    assert.equal(await complete({ system: 'rules', prompt: 'Read this', images: [file], key: 'unit-only-key', apiBase: 'https://fixture.invalid', model: 'vision-test', json: true }), '{}');
    fs.writeFileSync(file, 'not a PNG');
    await assert.rejects(() => complete({ system: '', prompt: '', images: [file], key: 'unit-only-key' }), /PNG/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('vision cannot forward a text API key to another provider implicitly', () => {
  const previousBase = config.visionApiBase, previousKey = process.env.CX_VISION_API_KEY, previousCredentials = config.credentials;
  try {
    config.visionApiBase = 'https://different.invalid'; delete process.env.CX_VISION_API_KEY;
    config.credentials = path.join(os.tmpdir(), `missing-credentials-${process.pid}-${Date.now()}`);
    assert.throws(() => loadVisionKey(), /单独配置/);
  } finally {
    config.visionApiBase = previousBase;
    config.credentials = previousCredentials;
    if (previousKey === undefined) delete process.env.CX_VISION_API_KEY; else process.env.CX_VISION_API_KEY = previousKey;
  }
});

test('visual popup memory cannot cross-match different images with identical blank DOM text', () => {
  const first = { q: '', opts: ['', ''], needsVisual: true, multi: false, visualHash: 'one' };
  const second = { ...first, visualHash: 'two' };
  const memory = { [questionKey(first)]: { picks: [1], correct: [''] } };
  assert.deepEqual(memoryAnswer(first, memory), [1]); assert.equal(memoryAnswer(second, memory), null);
  assert.equal(memoryAnswer({ ...first, visualHash: undefined }, memory), null);
  memory[questionKey(first)] = { picks: [1], correct: [''], tried: [['']], triedPicks: [[0]] };
  assert.deepEqual(memoryAnswer(first, memory), [1]); // Empty DOM texts must not reject every visual option.
  memory[questionKey(first)].picks = [0];
  assert.equal(memoryAnswer(first, memory), null);
});
