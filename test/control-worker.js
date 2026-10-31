// Local-only process used to exercise cooperative stop without opening a browser.
const fs = require('node:fs');
const path = require('node:path');
const { runManaged } = require('../scripts/control');
const config = require('../scripts/toolkit/config');
runManaged({ courseInput: process.argv[2], command: 'run', chapter: '9' }, () => new Promise((resolve, reject) => {
  process.once('SIGINT', () => reject(new Error('任务已中断')));
  fs.writeFileSync(path.join(config.data, 'worker-ready'), 'ready');
})).catch(error => { process.exitCode = error.exitCode || 1; });
