const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runVideo } = require('../lib/workflow');
const { parseArgs } = require('../lib/runner');

const common = { playback: { rate: 2, memory: {}, maxMs: 10000, acceleration: { seek: true } }, wait: async () => {}, confirm: async () => false };

test('acceleration is explicit, has a shadow-only option, and keeps normal rate bounds', () => {
  const parsed = parseArgs(['video', 'example', '9', '--accelerate', '--no-seek', '--rate', '1.5']);
  assert.equal(parsed.options.accelerate, true); assert.equal(parsed.options['no-seek'], true);
  assert.throws(() => parseArgs(['video', 'example', '9', '--no-seek']), /配合/);
  assert.throws(() => parseArgs(['status', 'example', '--accelerate']), /适用于/);
  assert.throws(() => parseArgs(['video', 'example', '9', '--rate', '16']), /0.5–2/);
});

test('shadow completion needs a real successful playback result and never rewrites normal rate', async () => {
  const playback = { ...common.playback, acceleration: { seek: false } };
  const result = await runVideo({ page: {} }, {}, '9', {}, { ...common, playback,
    play: async (_, __, options) => { assert.ok(options.acceleration); return { status: 'completed', actualRate: 16, confirmation: 'online-marker' }; },
  });
  assert.equal(result.acceleration.verified, true); assert.equal(result.acceleration.fellBack, false);
  assert.equal(playback.rate, 2); assert.equal(result.actualRate, 16);
});

test('already completed tasks are skipped without certifying acceleration', async () => {
  const result = await runVideo({ page: {} }, {}, '9', {}, { ...common,
    play: async () => ({ status: 'completed', already: true }),
  });
  assert.equal(result.acceleration.used, false); assert.equal(result.acceleration.verified, false);
});

test('unconfirmed accelerated playback falls back once to a fresh normal replay from zero', async () => {
  const playback = { ...common.playback, acceleration: { seek: true } };
  let plays = 0, opens = 0;
  const result = await runVideo({ page: {} }, {}, '9', {}, { ...common, playback,
    openChapter: async () => { opens++; },
    play: async (_, __, options) => {
      if (++plays === 1) return { status: 'unconfirmed', acceleration: { actualRate: 16, reportedRate: 1 } };
      assert.equal(options.acceleration, null); assert.equal(options.restart, true); assert.equal(options.rate, 2);
      return { status: 'completed', actualRate: 2 };
    },
  });
  assert.equal(opens, 1); assert.equal(plays, 2);
  assert.equal(result.acceleration.fellBack, true); assert.equal(result.acceleration.verified, false);
});

test('delayed platform confirmation prevents an unnecessary normal replay', async () => {
  const result = await runVideo({ page: {} }, {}, '9', {}, { ...common,
    play: async () => ({ status: 'unconfirmed' }), confirm: async () => true,
    openChapter: () => assert.fail('must not restart confirmed task'),
  });
  assert.equal(result.status, 'completed'); assert.equal(result.acceleration.verified, true);
});

test('seek rejection, shadow rejection and setup failure all use a two-speed fallback', async () => {
  for (const mode of ['seek-blocked', 'rejected', 'setup-error']) {
    let plays = 0;
    const result = await runVideo({ page: {} }, {}, '9', {}, { ...common, playback: { ...common.playback, rate: 1.5, acceleration: { seek: mode === 'seek-blocked' } }, openChapter: async () => {},
      play: async (_, __, options) => {
        if (++plays === 1) {
          if (mode === 'setup-error') throw Object.assign(Error('property is nonconfigurable'), { code: 'ACCELERATION_UNAVAILABLE' });
          return { status: 'acceleration-rejected' };
        }
        assert.equal(options.restart, true); assert.equal(options.acceleration, null); assert.equal(options.rate, 2);
        return { status: 'completed' };
      },
    });
    assert.equal(result.acceleration.fellBack, true); assert.equal(plays, 2);
  }
});

test('blocked normal restart is reported instead of claiming accelerated success', async () => {
  let plays = 0;
  const result = await runVideo({ page: {} }, {}, '9', {}, { ...common, playback: { ...common.playback, acceleration: { seek: true } }, openChapter: async () => {},
    play: async () => ++plays === 1 ? { status: 'unconfirmed' } : { status: 'restart-blocked' },
  });
  assert.equal(result.status, 'restart-blocked'); assert.equal(result.acceleration.verified, false);
});

test('strict platform never passing ends unconfirmed after normal and one-speed fallbacks', async () => {
  const speeds = [];
  const result = await runVideo({ page: {}, logs: [{ jobId: 'job', body: { isPassed: false } }] }, {}, '9', { jobId: 'job' }, {
    ...common, playback: { ...common.playback, acceleration: { seek: false } }, openChapter: async () => {},
    play: async (_, __, options) => { speeds.push({ shadow: Boolean(options.acceleration), rate: options.rate, restart: options.restart }); return { status: 'unconfirmed' }; },
  });
  assert.deepEqual(speeds.map(s => [s.shadow, s.rate]), [[true, 2], [false, 2], [false, 1]]);
  assert.equal(speeds[1].restart, true); assert.equal(speeds[2].restart, true);
  assert.equal(result.status, 'unconfirmed'); assert.equal(result.acceleration.verified, false);
});
