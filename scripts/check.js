const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`不分发符号链接：${file}`);
    return entry.isDirectory() ? files(file) : [file];
  });
}
let failed = false;
const sources = ['scripts', 'test'].flatMap(dir => files(path.join(root, dir)));
for (const file of sources.filter(f => f.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { failed = true; console.error(path.relative(root, file), result.stderr); }
}
for (const row of JSON.parse(fs.readFileSync(path.join(root, 'engine-manifest.json'), 'utf8')).files) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, row.target))).digest('hex');
  if (actual.toLowerCase() !== row.sha256.toLowerCase()) { failed = true; console.error(`引擎副本摘要不匹配：${row.target}`); }
}
for (const file of [path.join(root, 'SKILL.md'), ...files(path.join(root, 'references'))]) {
  const content = fs.readFileSync(file, 'utf8');
  for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^https?:/.test(target)) continue;
    const resolved = path.resolve(path.dirname(file), target.split('#')[0]);
    if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) { failed = true; console.error(`引用无效：${path.relative(root, file)} → ${target}`); }
  }
}
if (failed) process.exitCode = 1;
else console.log(`PASS: ${sources.filter(f => f.endsWith('.js')).length} JavaScript文件、引擎副本摘要与文档引用`);
