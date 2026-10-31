const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('../config');
const { acquireLock } = require('./store');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class PageError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function classifyPage(url, text = '') {
  if (/antispider/i.test(url)) return 'CAPTCHA';
  if (/passport2?\.|\/login(?:[/?]|$)/i.test(url)) return 'LOGIN';
  if (/操作异常|访问过于频繁|请输入图片中的验证码|【9010】/i.test(text)) return 'CAPTCHA';
  if (/enc\s*校验失败|enc.*失效/i.test(text)) return 'ENC_EXPIRED';
  if (/账号.*(?:锁定|冻结)|账户.*(?:锁定|冻结)/.test(text)) return 'ACCOUNT_LOCKED';
  return null;
}

async function assertPage(page) {
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 12000) || '');
  const code = classifyPage(page.url(), text);
  if (!code) return;
  let screenshot = '';
  if (code === 'CAPTCHA') {
    const directory = path.join(config.data, 'captcha'); fs.mkdirSync(directory, { recursive: true });
    screenshot = path.join(directory, `${Date.now()}.png`);
    await page.screenshot({ path: screenshot }).catch(() => {});
  }
  throw new PageError(code, `${code}：${code === 'CAPTCHA' ? `请在浏览器人工完成验证后重跑。截图 ${screenshot}` : code === 'LOGIN' ? '请在浏览器登录后重跑' : '请检查浏览器页面'}`);
}

async function closeStalledNotices(cdp, log = console.log) {
  const targets = await (await fetch(`${cdp}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  let closed = 0;
  for (const target of targets) {
    let url;
    try { url = new URL(target.url); } catch { continue; }
    // This platform notification can hang Page.enable for every CDP client.
    // Never apply this recovery to course pages, login, quizzes or verification challenges.
    if (target.type !== 'page' || url.hostname !== 'detect.chaoxing.com' || url.pathname !== '/api/monitor_temp') continue;
    const response = await fetch(`${cdp}/json/close/${encodeURIComponent(target.id)}`, { signal: AbortSignal.timeout(5000) });
    if (response.ok) { closed++; log('BROWSER_NOTICE_CLOSED', '已关闭阻塞 CDP 初始化的登录通知标签'); }
  }
  return closed;
}

async function attach({ startUrl, log = console.log } = {}) {
  const release = acquireLock([`cdp:${config.cdp}`, `profile:${process.platform === 'win32' ? config.profile.toLowerCase() : config.profile}`]);
  let browser, page;
  try {
    let chromium;
    try { ({ chromium } = require(config.playwright)); }
    catch { throw new Error('找不到 playwright-core，请 npm install 或设置 CX_PLAYWRIGHT'); }
    const reachable = async () => {
      try { return (await fetch(`${config.cdp}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; }
      catch { return false; }
    };
    if (!await reachable()) {
      if (process.env.CX_CDP) throw new Error('指定的 CX_CDP 无法连接');
      const child = spawn(config.chrome, [`--user-data-dir=${config.profile}`, `--remote-debugging-port=${config.port}`, '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore', windowsHide: true });
      let launchError;
      child.on('error', error => { launchError = error; }); child.unref();
      const deadline = Date.now() + config.timeoutMs;
      while (!await reachable()) {
        if (launchError) throw launchError;
        if (Date.now() > deadline) throw new Error(`Chrome 无法连接 ${config.cdp}`);
        await sleep(500);
      }
    }
    try { browser = await chromium.connectOverCDP(config.cdp, { timeout: config.timeoutMs }); }
    catch (error) {
      if (!/Timeout/i.test(error.message) || !await closeStalledNotices(config.cdp, log)) throw error;
      browser = await chromium.connectOverCDP(config.cdp, { timeout: config.timeoutMs });
    }
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('浏览器没有可用上下文');
    page = await ctx.newPage();
    const logs = [];
    page.on('response', async response => {
      if (!response.url().includes('/multimedia/log')) return;
      try {
        const url = new URL(response.url());
        logs.push({ at: new Date().toISOString(), jobId: url.searchParams.get('jobid'), objectId: url.searchParams.get('objectId'), playingTime: url.searchParams.get('playingTime'), duration: url.searchParams.get('duration'), isdrag: url.searchParams.get('isdrag'), rt: url.searchParams.get('rt'), body: await response.json() });
        if (logs.length > 300) logs.shift();
      } catch {}
    });
    let closed = false;
    const close = async ({ keepPage = false } = {}) => {
      if (closed) return; closed = true;
      try { if (!keepPage) await page.close().catch(() => {}); await browser.close(); }
      finally { release(); }
    };
    if (startUrl) await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    return { browser, ctx, page, logs, close };
  } catch (error) {
    await page?.close().catch(() => {}); await browser?.close().catch(() => {}); release(); throw error;
  }
}

module.exports = { attach, sleep, classifyPage, assertPage, PageError, closeStalledNotices };
