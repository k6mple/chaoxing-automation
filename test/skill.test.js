const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const config = require('../scripts/toolkit/config');
const { readJson, writeJson, courseDirectory, acquireLock } = require('../scripts/toolkit/lib/store');
const { resolveCourse } = require('../scripts/toolkit/lib/course');
const { questionKey } = require('../scripts/toolkit/lib/video');
const { activeRun, progress, requestStop, runManaged } = require('../scripts/control');
const { remember } = require('../scripts/remember');
const cli = path.resolve(__dirname, '../scripts/cx.js');
const configFile = path.resolve(__dirname, '../scripts/toolkit/config.js');
const courseUrl = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=100&clazzid=200&cpi=300&enc=offline-fixture';
function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cx-skill test-')); }
function environment(data) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CX_') || key === 'DEEPSEEK_API_KEY') delete env[key];
  if (data) env.CX_DATA = data;
  return env;
}
function call(args, data) { return spawnSync(process.execPath, [cli, ...args], { cwd: data, env: environment(data), encoding: 'utf8', timeout: 10000 }); }
async function inData(action) {
  const original = config.data, directory = temporary(); config.data = directory;
  try { return await action(directory); }
  finally { config.data = original; fs.rmSync(directory, { recursive: true, force: true }); }
}

test('portable defaults use caller data/profile, not original project or personal credentials', () => {
  const directory = temporary();
  try {
    const run = spawnSync(process.execPath, ['-e', 'const c=require(process.argv[1]);console.log(JSON.stringify({data:c.data,profile:c.profile,credentials:c.credentials,playwright:c.playwright}))', configFile], { cwd: directory, env: environment(), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const value = JSON.parse(run.stdout);
    assert.equal(value.data, path.join(directory, '.chaoxing')); assert.equal(value.profile, path.join(directory, '.chaoxing/chrome-profile'));
    assert.equal(value.credentials, path.join(directory, '.chaoxing/credentials.yaml'));
    assert.equal(value.playwright, path.resolve(__dirname, '../node_modules/playwright-core'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('help and offline progress work from a different directory without creating runtime data', () => {
  const directory = temporary();
  try {
    const help = call(['--help'], directory); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /remember/);
    const report = call(['progress'], directory); assert.equal(report.status, 0, report.stderr); assert.equal(JSON.parse(report.stdout).status, 'idle');
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('doctor reports credential presence without emitting secrets or starting Chrome', () => {
  const directory = temporary();
  try {
    const secret = 'offline-test-key-never-print';
    const run = spawnSync(process.execPath, [cli, 'doctor'], { cwd: directory, env: { ...environment(directory), DEEPSEEK_API_KEY: secret }, encoding: 'utf8', timeout: 10000 });
    const value = JSON.parse(run.stdout); assert.ok(!run.stdout.includes(secret));
    assert.equal(value.ai.textKeyConfigured, true); assert.equal(value.dataDirectory, directory);
    assert.equal(value.checks.some(check => check.name === 'cdp'), false);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('progress exposes stale lifecycle and local failures without claiming online completion', async () => inData(async directory => {
  const course = resolveCourse(courseUrl), runtime = courseDirectory(course);
  writeJson(path.join(directory, 'control/active-run.json'), { pid: 2147483647, status: 'running', course, token: 'fixture' });
  writeJson(path.join(runtime, 'tasks.json'), { a: { status: 'completed' }, b: { status: 'needs-answer' }, c: { status: 'running', t: 12, at: 'now' } });
  writeJson(path.join(runtime, 'run-report.json'), { status: 'incomplete', failures: [{ taskKey: 'b' }] });
  fs.writeFileSync(path.join(runtime, 'events.jsonl'), JSON.stringify({ event: 'PLAYING', data: { t: 12 } }) + '\n');
  const result = progress(); assert.equal(result.status, 'crashed'); assert.equal(result.active.alive, false);
  assert.equal(result.taskCounts['needs-answer'], 1); assert.equal(result.report.status, 'incomplete');
  assert.equal(result.currentTask.t, 12); assert.equal(requestStop().requested, false);
}));

test('stop request is consumed by the owning process and cleanup reports stopped', async () => {
  const directory = temporary();
  const child = spawn(process.execPath, [path.join(__dirname, 'control-worker.js'), courseUrl], { cwd: directory, env: environment(directory), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stderr.on('data', data => { output += data; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(directory, 'worker-ready'))) { if (Date.now() > deadline) throw Error('worker did not start: ' + output); await new Promise(resolve => setTimeout(resolve, 20)); }
    const request = call(['stop'], directory); assert.equal(request.status, 0, request.stderr); assert.equal(JSON.parse(request.stdout).requested, true);
    const result = await exited; assert.equal(result.code, 130, output);
    const report = JSON.parse(call(['progress'], directory).stdout); assert.equal(report.active.status, 'stopped'); assert.equal(report.active.alive, false);
    assert.equal(JSON.parse(call(['stop'], directory).stdout).requested, false);
  } finally { if (child.exitCode === null) child.kill(); await exited; fs.rmSync(directory, { recursive: true, force: true }); }
});

test('old stop tokens cannot cancel a fresh run', async () => inData(async directory => {
  writeJson(path.join(directory, 'control/stop.json'), { token: 'old', at: 'before' });
  let calls = 0;
  await runManaged({ courseInput: courseUrl, command: 'prepare', chapter: '9' }, async () => { calls++; await new Promise(resolve => setTimeout(resolve, 40)); }, { pollMs: 10 });
  assert.equal(calls, 1); assert.equal(activeRun().status, 'completed');
}));

test('Agent video answers preserve rejection history, reject bad input, and do not mutate task status', async () => inData(async directory => {
  const runtime = courseDirectory(resolveCourse(courseUrl));
  const q = { q: 'Select all valid options', multi: true, opts: ['One', 'Two', 'Three'] }, key = questionKey(q);
  writeJson(path.join(runtime, 'video-questions.json'), { [key]: q });
  writeJson(path.join(runtime, 'video-memory.json'), { [key]: { correct: null, tried: [['One']], triedPicks: [[0]] } });
  writeJson(path.join(runtime, 'tasks.json'), { task: { status: 'needs-answer' } });
  assert.throws(() => remember(courseUrl, key, '[0]'), /判错/);
  assert.throws(() => remember(courseUrl, key, '[0,0]'), /不合法/);
  assert.throws(() => remember(courseUrl, 'missing', '[1]'), /不存在/);
  const result = remember(courseUrl, key, '[0,1]'); assert.equal(result.verified, false);
  const saved = readJson(path.join(runtime, 'video-memory.json'))[key]; assert.deepEqual(saved.correct, ['One', 'Two']); assert.deepEqual(saved.tried, [['One']]);
  assert.equal(readJson(path.join(runtime, 'tasks.json')).task.status, 'needs-answer');
  const release = acquireLock([`course:${runtime}`]);
  try { assert.throws(() => remember(courseUrl, key, '[1]'), /正在被进程/); } finally { release(); }
  writeJson(path.join(directory, 'control/active-run.json'), { pid: process.pid, token: 'busy', status: 'running' });
  assert.throws(() => remember(courseUrl, key, '[1]'), /先stop/);
}));
