const fs = require('node:fs');
const config = require('./toolkit/config');
const { loadKey, loadVisionKey } = require('./toolkit/lib/ai');

function origin(url) { try { return new URL(url).origin; } catch { return '(invalid URL)'; } }
async function doctor({ connect = false } = {}) {
  const checks = [], notes = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add('node', Number(process.versions.node.split('.')[0]) >= 22, process.version);
  try { require(config.playwright); add('playwright-core', true, '已安装'); }
  catch { add('playwright-core', false, '在 Skill 文件夹执行 npm ci，或显式设置 CX_PLAYWRIGHT'); }
  const hasChrome = fs.existsSync(config.chrome);
  add('chrome', hasChrome || Boolean(process.env.CX_CDP), hasChrome ? config.chrome : process.env.CX_CDP ? '使用指定 CDP，不启动本地浏览器' : '未找到 Chrome；设置 CX_CHROME 为可执行文件绝对路径');
  let textKey = false, visionKey = false;
  try { textKey = Boolean(loadKey()); } catch (error) { notes.push(error.message); }
  try { visionKey = Boolean(loadVisionKey()); } catch (error) { notes.push(error.message); }
  if (!textKey) notes.push('未配置文本AI密钥；仍可读取状态或使用显式答案，自动未知题需要配置密钥');
  if (!visionKey) notes.push('未配置识图密钥；加密/图片题需要可用视觉模型');
  if (connect) {
    try {
      const response = await fetch(`${config.cdp.replace(/\/$/, '')}/json/version`, { signal: AbortSignal.timeout(3000) });
      add('cdp', response.ok, response.ok ? 'CDP已响应，未打开页面或运行任务' : `HTTP ${response.status}`);
    } catch { add('cdp', false, 'CDP未响应；未启动浏览器'); }
  }
  return { ready: checks.every(c => c.ok), checks, dataDirectory: config.data, profile: config.profile,
    ai: { textEndpoint: origin(config.apiBase), textModel: config.model, textKeyConfigured: textKey, visionEndpoint: origin(config.visionApiBase), visionModel: config.visionModel, visionKeyConfigured: visionKey }, notes };
}
module.exports = { doctor };
