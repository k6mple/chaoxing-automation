const fs = require('node:fs');
const path = require('node:path');
const env = process.env;
const root = path.resolve(__dirname, '../..');
const data = path.resolve(env.CX_DATA || path.join(process.cwd(), '.chaoxing'));

function number(name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} 必须在 ${min}–${max} 之间`);
  return value;
}

function executable(name) {
  if (fs.existsSync(name)) return path.resolve(name);
  for (const directory of (env.PATH || env.Path || '').split(path.delimiter)) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function chromePath() {
  if (env.CX_CHROME) return executable(env.CX_CHROME) || env.CX_CHROME;
  const candidates = process.platform === 'win32'
    ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).map(dir => path.join(dir, 'Google/Chrome/Application/chrome.exe'))
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  return candidates.map(executable).find(Boolean) || candidates[0] || 'google-chrome';
}

module.exports = {
  root, data,
  playwright: env.CX_PLAYWRIGHT || path.join(root, 'node_modules/playwright-core'),
  chrome: chromePath(),
  profile: path.resolve(env.CX_PROFILE || path.join(data, 'chrome-profile')),
  port: number('CX_PORT', 9222, 1, 65535),
  get cdp() { return env.CX_CDP || `http://127.0.0.1:${this.port}`; },
  credentials: path.resolve(env.CX_CREDENTIALS || path.join(data, 'credentials.yaml')),
  apiKey: env.DEEPSEEK_API_KEY || null,
  model: env.CX_MODEL || 'deepseek-chat',
  timezone: env.CX_TIMEZONE || 'Asia/Shanghai',
  apiBase: env.CX_API_BASE || 'https://api.deepseek.com',
  visionModel: env.CX_VISION_MODEL || 'deepseek-flash',
  visionApiBase: env.CX_VISION_API_BASE || env.CX_API_BASE || 'https://api.deepseek.com',
  visionTimeoutMs: number('CX_VISION_TIMEOUT_MS', 90000, 1000, 180000),
  rate: number('CX_RATE', 2, 0.5, 2),
  intervalMs: number('CX_INTERVAL_MS', 8000, 0, 60000),
  timeoutMs: number('CX_TIMEOUT_MS', 30000, 1000, 120000),
  loginTimeoutMs: number('CX_LOGIN_TIMEOUT_MS', 120000, 0, 600000),
};
