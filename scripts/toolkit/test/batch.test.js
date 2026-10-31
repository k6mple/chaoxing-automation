const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseBatch, solveBatch } = require('../lib/batch-answer');
const { buildPlan, assertPlan } = require('../lib/quiz');
const choice = { qid: 'c', type: '单选', stem: 'Choose', opts: [{ k: 'A', t: 'One' }, { k: 'B', t: 'Two' }] };
const blank = { qid: 'b', type: '填空', stem: 'Fill', opts: [], fields: ['answerEditorb1'] };
const multi = { ...choice, qid: 'm', type: '多选' };
const json = answers => JSON.stringify({ answers: Object.entries(answers).map(([qid, answer]) => ({ qid, answer })) });
const manifest = input => JSON.parse(input.prompt.split('题目：').at(-1));

test('two independent group requests accept matching choices and blanks', async () => {
  const inputs = [];
  const result = await solveBatch([choice, blank], { request: async input => {
    inputs.push(input); assert.deepEqual(manifest(input).map(q => q.qid), ['c', 'b']);
    assert.ok(!input.prompt.includes('上一轮')); return json({ b: ['filled'], c: ['A'] });
  } });
  assert.equal(inputs.length, 2); assert.equal(result.audit.requestCount, 2);
  assert.deepEqual(result.results.get('c').keys, ['A']); assert.deepEqual(result.results.get('b').texts, ['filled']);
  assert.equal(result.audit.reviews.length, 0); assert.equal(inputs[0].prompt, inputs[1].prompt);
  assert.notEqual(inputs[0].system, inputs[1].system);
});

test('only disputed items are reviewed; review must match an independent answer', async () => {
  let calls = 0;
  const result = await solveBatch([choice, blank], { request: async input => {
    const call = ++calls;
    if (call < 3) return json({ c: [call === 1 ? 'A' : 'B'], b: ['same'] });
    assert.deepEqual(manifest(input).map(q => q.qid), ['c']); return json({ c: ['B'] });
  } });
  assert.equal(calls, 3); assert.deepEqual(result.results.get('c').keys, ['B']);
  assert.equal(result.results.get('c').batch.agreedInitially, false);
  assert.equal(result.results.get('b').batch.agreedInitially, true);
});

test('missing or invalid rows cannot be silently accepted', async () => {
  assert.ok(parseBatch(json({ c: ['A'] }), [choice, blank]).get('b').error);
  assert.ok(parseBatch(json({ unknown: ['A'] }), [choice]).get('c').error);
  assert.ok(parseBatch('{"answers":[{"qid":"c","answer":["A"]},{"qid":"c","answer":["B"]}]}', [choice]).get('c').error);
  let calls = 0;
  const result = await solveBatch([choice], { request: async () => { calls++; return calls === 1 ? json({ c: ['A'] }) : 'invalid'; } });
  assert.ok(result.results.get('c').error);
});

test('multi-select order is normalized; blank order and exact text are preserved', async () => {
  let calls = 0;
  const result = await solveBatch([multi, blank], { request: async () => ++calls === 1 ? json({ m: ['B', 'A'], b: ['第一空'] }) : json({ m: ['A', 'B'], b: ['第一空'] }) });
  assert.equal(calls, 2); assert.deepEqual(result.results.get('m').keys, ['A', 'B']);
  assert.ok(parseBatch(json({ b: ['one', 'two'] }), [blank]).get('b').error);
  assert.ok(parseBatch(json({ b: ['<b>word</b>'] }), [blank]).get('b').error);
});

test('unresolved three-way disagreement stops a complete plan', async () => {
  const q = { ...choice, opts: [...choice.opts, { k: 'C', t: 'Three' }] };
  const outputs = ['A', 'B', 'C'];
  const plan = await buildPlan([q], { ai: true, request: async () => json({ c: [outputs.shift()] }) });
  assert.throws(() => assertPlan(plan), /未形成/);
});

test('batch plan keeps manual answers out of API payloads', async () => {
  let audit;
  const plan = await buildPlan([choice, blank], { ai: true, answers: { b: ['manual'] }, request: async input => {
    assert.deepEqual(manifest(input).map(q => q.qid), ['c']); return json({ c: ['B'] });
  }, onBatchAudit: result => { audit = result; } });
  assertPlan(plan); assert.equal(audit.requestCount, 2); assert.deepEqual(plan[1].texts, ['manual']);
});

test('image batches use the vision provider and attach original diagrams to both rounds', async () => {
  let calls = 0;
  const q = { ...choice, needsVisual: true, imagePath: '/fixture/diagram.png' };
  const result = await solveBatch([q], { request: () => assert.fail('must use vision'), visionRequest: async input => {
    calls++; assert.deepEqual(input.images, [q.imagePath]); assert.equal(manifest(input)[0].image, 1); return json({ c: ['A'] });
  } });
  assert.equal(calls, 2); assert.deepEqual(result.results.get('c').keys, ['A']);
});

test('large exams split at a bounded batch size and keep all IDs', async () => {
  const questions = Array.from({ length: 21 }, (_, i) => ({ ...choice, qid: `q${i}` }));
  const result = await solveBatch(questions, { request: async input => json(Object.fromEntries(manifest(input).map(q => [q.qid, ['A']]))) });
  assert.equal(result.audit.requestCount, 4); assert.equal(result.results.size, 21);
  await assert.rejects(() => solveBatch([choice, choice]), /重复/);
});
