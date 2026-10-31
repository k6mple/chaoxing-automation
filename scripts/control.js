const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./toolkit/config');
const { readJson, writeJson, acquireLock, courseDirectory } = require('./toolkit/lib/store');
const { resolveCourse } = require('./toolkit/lib/course');

const activeFile = () => path.join(config.data, 'control/active-run.json');
const stopFile = () => path.join(config.data, 'control/stop.json');
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function activeRun() {
  const run = readJson(activeFile(), null);
  return run ? { ...run, alive: ['running', 'stopping'].includes(run.status) && alive(run.pid) } : null;
}
function requestStop() {
  const run = activeRun();
  if (!run?.alive) return { requested: false, status: 'idle', message: '此数据目录没有活动的 Skill 进程' };
  writeJson(stopFile(), { token: run.token, at: new Date().toISOString() });
  return { requested: true, status: 'stop-requested', pid: run.pid, message: '等待进程协作停止；请用 progress 确认 stopped' };
}

async function runManaged(parsed, execute, { pollMs = 250 } = {}) {
  const course = resolveCourse(parsed.courseInput);
  const release = acquireLock([`skill-control:${config.data}`]);
  const run = { token: crypto.randomUUID(), pid: process.pid, status: 'running', command: parsed.command,
    chapters: parsed.chapter?.split(',') || null, course: { courseId: course.courseId, clazzId: course.clazzId, cpi: course.cpi },
    startedAt: new Date().toISOString() };
  let timer, signalled = false;
  try {
    writeJson(activeFile(), run);
    timer = setInterval(() => {
      try {
        const stop = readJson(stopFile(), null);
        if (signalled || stop?.token !== run.token || !process.listenerCount('SIGINT')) return;
        signalled = true; run.status = 'stopping'; run.stopRequestedAt = stop.at; writeJson(activeFile(), run);
        process.emit('SIGINT'); // Use the engine's AbortController and pause/close cleanup.
      } catch (error) { console.error(`读取停止请求失败：${error.message}`); }
    }, pollMs);
    await execute();
    run.status = signalled ? 'stopped' : 'completed';
  } catch (error) {
    run.status = signalled ? 'stopped' : error.code === 'INCOMPLETE' ? 'incomplete' : 'failed';
    run.error = { code: error.code || (signalled ? 'INTERRUPTED' : 'FAILED'), message: error.message };
    if (signalled) error.exitCode = 130;
    throw error;
  } finally {
    clearInterval(timer); run.endedAt = new Date().toISOString();
    try { writeJson(activeFile(), run); } finally { release(); }
  }
}

function tailEvents(file, bytes = 32768) {
  if (!fs.existsSync(file)) return [];
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes), buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8').split('\n').slice(start ? 1 : 0).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } finally { fs.closeSync(fd); }
}
function progress(input) {
  const active = activeRun();
  const course = input ? resolveCourse(input) : active?.course;
  if (!course) return { active: null, status: 'idle', message: '尚无运行记录；也可指定课程 URL 读取本地状态' };
  const directory = courseDirectory(course), tasks = readJson(path.join(directory, 'tasks.json'), {});
  const counts = {};
  for (const task of Object.values(tasks)) counts[task.status || 'unknown'] = (counts[task.status || 'unknown'] || 0) + 1;
  const current = Object.entries(tasks).filter(([, t]) => t.status === 'running').sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)))[0];
  const events = tailEvents(path.join(directory, 'events.jsonl'));
  const sameCourse = active && ['courseId', 'clazzId', 'cpi'].every(key => String(active.course[key]) === String(course[key]));
  return { active: sameCourse ? active : null, status: sameCourse && !active.alive && ['running', 'stopping'].includes(active.status) ? 'crashed' : sameCourse ? active.status : 'offline',
    directory, taskCounts: counts, currentTask: current ? { key: current[0], ...current[1] } : null,
    report: readJson(path.join(directory, 'run-report.json'), null), lastEvents: events.slice(-5) };
}
module.exports = { activeRun, requestStop, runManaged, progress };
