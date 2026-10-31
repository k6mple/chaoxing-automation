const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runVideo, prepareVideoAnswer } = require('../lib/workflow');
const { questionKey, memoryAnswer } = require('../lib/video');
const { askLLM } = require('../lib/answer');
const { isFatal, isTransient, taskKey, reconcileTasks } = require('../lib/recovery');

const question = { q: 'Example', type: '多选', multi: true, opts: ['One', 'Two', 'Three'] };
const key = questionKey(question);
const unresolved = reason => ({ status: 'needs-answer', reason, questions: [{ ...question, key }] });
const base = { playback: { memory: {}, maxMs: 10000 }, wait: async () => {}, hasPopup: async () => true };

test('wrong feedback triggers fresh AI preparation with rejected combinations, in place', async () => {
  const memory = { [key]: { correct: null, tried: [['One']] } };
  let calls = 0, prepared = 0;
  const result = await runVideo({ page: {}, logs: [] }, {}, '1', {}, {
    ...base, playback: { ...base.playback, memory },
    play: async (_, __, options) => {
      if (++calls === 1) return unresolved('wrong');
      assert.equal(options.resume, true); assert.equal(options.pendingQuestion, key);
      assert.deepEqual(memoryAnswer(question, options.memory), [0, 1]);
      return { status: 'completed', answered: 1 };
    },
    prepare: async q => { prepared++; assert.deepEqual(q.tried, [['One']]); return { correct: ['One', 'Two'], picks: [0, 1] }; },
    openChapter: () => assert.fail('must retain page for a live popup'),
  });
  assert.equal(result.status, 'completed'); assert.equal(result.answered, 1); assert.equal(prepared, 1);
  assert.deepEqual(memory[key].tried, [['One']]);
});

test('a closed unknown popup is reopened with a pending obligation, even if task passed', async () => {
  let plays = 0, opens = 0;
  const result = await runVideo({ page: {} }, {}, '1', {}, {
    ...base, playback: { ...base.playback, memory: {} }, hasPopup: async () => false,
    play: async (_, __, options) => { if (++plays === 1) return unresolved('needs-answer'); assert.equal(options.pendingQuestion, key); return { status: 'completed' }; },
    prepare: async () => ({ correct: ['One'] }), openChapter: async () => { opens++; },
  });
  assert.equal(result.status, 'completed'); assert.equal(opens, 1);
});

test('correct popup continuation is retried on the same page with a hard bound', async () => {
  let plays = 0;
  const result = await runVideo({ page: {} }, {}, '1', {}, {
    ...base, play: async () => { plays++; return unresolved('needs-continue'); },
    prepare: () => assert.fail('must not resubmit or ask AI for a correct answer'),
    openChapter: () => assert.fail('must not reopen the correct popup'),
  });
  assert.equal(result.reason, 'needs-continue'); assert.equal(plays, 3);
});

test('stalled video recovery is bounded to two reloads; account blockers never retry', async () => {
  let opens = 0;
  const result = await runVideo({ page: {} }, {}, '1', {}, { ...base, play: async () => ({ status: 'stalled' }), openChapter: async () => { opens++; } });
  assert.equal(opens, 2); assert.equal(result.status, 'stalled');
  opens = 0;
  await assert.rejects(() => runVideo({ page: {} }, {}, '1', {}, { ...base,
    play: async () => { throw Error('Frame was detached'); }, openChapter: async () => { opens++; },
  }), /detached/);
  assert.equal(opens, 2);
  for (const code of ['CAPTCHA', 'LOGIN', 'ACCOUNT_LOCKED']) {
    await assert.rejects(() => runVideo({ page: {} }, {}, '1', {}, { ...base,
      play: async () => { throw Object.assign(Error('blocked'), { code }); }, openChapter: () => assert.fail('blocker retry'),
    }), /blocked/);
  }
});

test('cancelled AI preparation cannot persist answers or resume playback', async () => {
  const controller = new AbortController();
  await assert.rejects(() => runVideo({ page: {} }, {}, '1', {}, {
    ...base, playback: { ...base.playback, memory: {}, signal: controller.signal },
    play: async () => unresolved('needs-answer'),
    prepare: async () => { controller.abort(); return { correct: ['One'] }; },
    saveMemory: () => assert.fail('cancelled answer persisted'),
  }), /abort/i);
});

test('AI wait shares the video time budget and cannot save an answer after timeout', async () => {
  const result = await runVideo({ page: {} }, {}, '1', {}, {
    ...base, playback: { memory: {}, maxMs: 20 },
    play: async () => unresolved('needs-answer'),
    prepare: async (_, __, { signal }) => new Promise(resolve => {
      const timer = setTimeout(() => resolve({ correct: ['One'] }), 1000);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve({ error: 'deadline' }); }, { once: true });
    }),
    saveMemory: () => assert.fail('answer saved after deadline'),
  });
  assert.equal(result.status, 'timeout');
});

test('AI filters platform-rejected whole sets without excluding their individual options', async () => {
  const q = { qid: key, stem: question.q, type: '多选', opts: question.opts.map((t, i) => ({ k: 'ABC'[i], t })) };
  const outputs = ['A', 'AB', 'AB'];
  const result = await askLLM(q, { rejectedAnswers: [['A']], request: async input => {
    assert.match(input.prompt, /完整答案组合/); return outputs.shift();
  } });
  assert.deepEqual(result.keys, ['A', 'B']);
  const bad = await askLLM(q, { rejectedAnswers: [['A']], request: async () => 'A' });
  assert.equal(bad.keys, null);
  const composed = ['AB', 'AC', 'BC', 'AB'];
  assert.equal((await askLLM(q, { request: async () => composed.shift() })).keys, null);
});

test('video AI maps rejected texts to current option order and keeps rejection history', async () => {
  const output = await prepareVideoAnswer({ ...question, tried: [['Three']] }, 'Example course', { request: async input => {
    assert.match(input.prompt, /\[\["C"\]\]/); return 'AB';
  } });
  assert.deepEqual(output.correct, ['One', 'Two']); assert.deepEqual(output.tried, [['Three']]);
  assert.equal(memoryAnswer(question, { [key]: { correct: ['One'], tried: [['One']] } }), null);
});

test('online completion reconciles stale local failures without discarding audit data', () => {
  const task = { type: 'video', card: 0, objectId: 'v', finished: true };
  const id = taskKey('1', task), state = { [id]: { status: 'failed', reason: 'needs-continue', error: 'old', heartbeats: [1] } };
  reconcileTasks(state, '1', [task], 'now');
  assert.equal(state[id].status, 'completed'); assert.equal(state[id].error, undefined);
  assert.deepEqual(state[id].heartbeats, [1]); assert.equal(state[id].at, 'now');
  assert.equal(isFatal({ code: 'CAPTCHA', message: '' }), true);
  assert.equal(isTransient(Error('Frame was detached')), true);
  assert.equal(isFatal(Error('ordinary task error')), false);
});

test('online green marker cannot erase a persisted unanswered popup', () => {
  const task = { type: 'video', index: 0, finished: true };
  const key = taskKey('9', task), state = { [key]: { status: 'needs-answer', pendingQuestion: 'tail', reason: 'missing popup' } };
  reconcileTasks(state, '9', [task]);
  assert.equal(state[key].status, 'needs-answer'); assert.equal(state[key].taskFinished, true);
  assert.equal(state[key].pendingQuestion, 'tail');
});
