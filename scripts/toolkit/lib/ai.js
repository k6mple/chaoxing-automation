const fs = require('node:fs');
const config = require('../config');

function credential(name) {
  if (process.env[name]) return process.env[name];
  if (!fs.existsSync(config.credentials)) return null;
  const match = fs.readFileSync(config.credentials, 'utf8').match(new RegExp(`^\\s*${name}\\s*:\\s*(?:"([^"\\n]+)"|'([^'\\n]+)'|([^\\s#]+))`, 'm'));
  return match ? match[1] || match[2] || match[3] : null;
}

function loadKey() { return config.apiKey || credential('DEEPSEEK_API_KEY'); }

function loadVisionKey() {
  const key = credential('CX_VISION_API_KEY');
  if (key) return key;
  if (new URL(config.visionApiBase).origin !== new URL(config.apiBase).origin) throw new Error('不同识图服务需单独配置 CX_VISION_API_KEY，不能向其他服务转发文本模型密钥');
  return loadKey();
}

async function complete({ system, prompt, temperature = 0, maxTokens = 32, images = [], model = config.model, apiBase = config.apiBase, key = loadKey(), timeoutMs = config.timeoutMs, json = false, signal }) {
  if (!key) throw new Error('缺少 DEEPSEEK_API_KEY；请设置环境变量或 CX_CREDENTIALS');
  const content = images.length ? [{ type: 'text', text: prompt }, ...images.map(file => {
    const bytes = fs.readFileSync(file);
    if (bytes.length > 20 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('识图输入必须是小于 20 MiB 的 PNG 截图');
    return { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}`, detail: 'original' } };
  })] : prompt;
  const body = JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content }], temperature, max_tokens: maxTokens, ...(json ? { response_format: { type: 'json_object' } } : {}) });
  if (Buffer.byteLength(body) > 48 * 1024 * 1024) throw new Error('识图请求超过 48 MiB，请减小截图批量');
  const response = await fetch(`${apiBase.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`AI HTTP ${response.status}`);
  const payload = await response.json();
  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('AI 返回空内容');
  return text;
}

function completeVision(input) {
  return complete({ ...input, model: config.visionModel, apiBase: config.visionApiBase, key: loadVisionKey(), timeoutMs: config.visionTimeoutMs });
}

module.exports = { complete, completeVision, loadKey, loadVisionKey };
