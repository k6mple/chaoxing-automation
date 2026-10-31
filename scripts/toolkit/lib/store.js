const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const config = require('../config');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    throw new Error(`无法读取 JSON ${file}: ${error.message}`, { cause: error });
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

function acquireLock(resources, directory = path.join(os.tmpdir(), 'chaoxing-toolkit-locks')) {
  fs.mkdirSync(directory, { recursive: true });
  const held = [];
  const token = crypto.randomUUID();
  const release = () => {
    for (const file of held.splice(0)) {
      try { if (readJson(file).token === token) fs.unlinkSync(file); } catch (error) { if (error.cause?.code !== 'ENOENT') console.error(`释放锁失败 ${file}: ${error.message}`); }
    }
  };
  try {
    for (const resource of [...new Set(resources)].sort()) {
      const file = path.join(directory, crypto.createHash('sha256').update(resource).digest('hex').slice(0, 24) + '.json');
      let acquired = false;
      for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
        try {
          const fd = fs.openSync(file, 'wx', 0o600);
          try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, resource, at: new Date().toISOString() })); }
          finally { fs.closeSync(fd); }
          held.push(file); acquired = true;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          let owner;
          try { owner = readJson(file); } catch { throw new Error(`锁文件无法解析，请人工检查：${file}`); }
          try { process.kill(owner.pid, 0); }
          catch (probe) {
            if (probe.code === 'ESRCH') { try { fs.unlinkSync(file); } catch (remove) { if (remove.code !== 'ENOENT') throw remove; } continue; }
          }
          throw new Error(`资源正在被进程 ${owner.pid} 使用：${resource}`);
        }
      }
      if (!acquired) throw new Error(`无法取得资源锁：${resource}`);
    }
    return release;
  } catch (error) { release(); throw error; }
}

function courseDirectory(course) {
  return path.join(config.data, 'runtime', `${course.courseId}-${course.clazzId}-${course.cpi}`);
}

module.exports = { readJson, writeJson, acquireLock, courseDirectory };
