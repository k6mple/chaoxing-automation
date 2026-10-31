#!/usr/bin/env node
const { parseArgs, runCli, HELP } = require('./toolkit/lib/runner');
const { runManaged, requestStop, progress } = require('./control');
const { doctor } = require('./doctor');
const { remember } = require('./remember');

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || command === 'help' || argv.includes('--help')) {
    console.log('学习通自动化 Skill\n从固定工作目录调用本文件；运行数据默认存放在该工作目录的 .chaoxing。\n');
    console.log('doctor [--connect]  检查环境；--connect 额外只读探测 CDP\nprogress [课程URL或key]  读取本地进度，不访问网站\nstop  请求当前 Skill 进程协作停止，再用 progress 确认\nremember <课程> <题目key> <JSON下标数组>  校验并保存Agent提供的视频答案\n');
    console.log(HELP.replace('环境变量见 README.md', '环境变量见 references/setup.md'));
    return;
  }
  if (command === 'doctor') {
    if (argv.slice(1).some(arg => arg !== '--connect')) throw new Error('doctor 只接受 --connect');
    const result = await doctor({ connect: argv.includes('--connect') }); console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 1;
    return;
  }
  if (command === 'progress') {
    if (argv.length > 2) throw new Error('progress 最多接受一个课程URL或key');
    console.log(JSON.stringify(progress(argv[1]), null, 2)); return;
  }
  if (command === 'stop') {
    if (argv.length !== 1) throw new Error('stop 不接受附加参数；使用同一个 CX_DATA 定位运行');
    console.log(JSON.stringify(requestStop(), null, 2)); return;
  }
  if (command === 'remember') {
    if (argv.length !== 4) throw new Error('remember 需要课程、题目key和JSON下标数组');
    console.log(JSON.stringify(remember(...argv.slice(1)), null, 2)); return;
  }
  const parsed = parseArgs(argv);
  await runManaged(parsed, () => runCli(argv));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = error.exitCode || 1; });
module.exports = { main };
