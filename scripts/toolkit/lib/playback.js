const config = require('../config');

async function setPlayback(frame, { rate = 2, shadow = false } = {}) {
  if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) throw new Error('正常播放倍速必须在0.5–2之间');
  return frame.evaluate(({ rate, shadow }) => {
    const video = document.querySelector('video');
    if (!video) throw new Error('播放器video元素消失');
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
    const key = Symbol.for('chaoxing-toolkit.playback');
    if (shadow) {
      if (!video[key]) video[key] = { own: Object.getOwnPropertyDescriptor(video, 'playbackRate'), rate: descriptor.get.call(video) };
      Object.defineProperty(video, 'playbackRate', {
        configurable: true, get: () => 1, set: () => descriptor.set.call(video, 16),
      });
      descriptor.set.call(video, 16);
    } else video.playbackRate = rate;
    video.muted = true;
    return { actualRate: descriptor.get.call(video), reportedRate: video.playbackRate };
  }, { rate, shadow });
}

async function restorePlayback(frame) {
  await frame.evaluate(() => {
    const video = document.querySelector('video');
    const key = Symbol.for('chaoxing-toolkit.playback'), saved = video?.[key];
    if (!saved) return;
    delete video.playbackRate;
    if (saved.own) Object.defineProperty(video, 'playbackRate', saved.own);
    Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate').set.call(video, saved.rate);
    delete video[key];
  });
}

async function seekVideo(frame, ratio, { timeoutMs = config.timeoutMs, settleMs = 1700 } = {}) {
  if (![0, 0.9].includes(ratio)) throw new Error('仅支持加速探测90%或失败后从头正常重播');
  try {
    await frame.waitForFunction(() => Number.isFinite(document.querySelector('video')?.duration) && document.querySelector('video').duration > 0, null, { timeout: timeoutMs });
  } catch (error) {
    if (!/Timeout/i.test(error.message)) throw error;
    return { status: 'unavailable', reason: '视频时长尚未就绪' };
  }
  return frame.evaluate(async ({ ratio, settleMs }) => {
    const video = document.querySelector('video');
    if ([...document.querySelectorAll('.ans-videoquiz')].some(el => el.offsetParent !== null)) return { status: 'deferred', reason: '当前有弹窗，先处理' };
    const from = video.currentTime, target = video.duration * ratio;
    if ((ratio && from >= target - 1) || (!ratio && from < 1)) return { status: 'not-needed', from, target, to: from };
    if (!video.paused) video.pause();
    try { video.currentTime = target; }
    catch (error) { return { status: 'blocked', from, target, to: video.currentTime, reason: error.message }; }
    await new Promise(resolve => setTimeout(resolve, settleMs));
    const to = video.currentTime;
    const accepted = ratio ? to >= target - 2 : to < 2;
    return { status: accepted ? 'accepted' : 'blocked', from, target, to };
  }, { ratio, settleMs });
}

module.exports = { setPlayback, restorePlayback, seekVideo };
