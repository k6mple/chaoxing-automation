// Global browser/account blockers must stop the queue; local task failures need not.
const FATAL_CODES = new Set(['CAPTCHA', 'LOGIN', 'ACCOUNT_LOCKED']);
function isFatal(error, signal) {
  return Boolean(signal?.aborted || FATAL_CODES.has(error.code) || /任务已中断|browser has been closed|browser.*disconnected|Target.*closed/i.test(error.message));
}
function isTransient(error) {
  return ['ENC_EXPIRED', 'FRAME_MISSING'].includes(error.code) || /Timeout|frame.*detached|execution context.*destroyed|net::ERR_/i.test(error.message);
}
function taskKey(chapterId, task) {
  return `${chapterId}:${task.card || 0}:${task.type}:${task.objectId || task.jobId || task.index}`;
}
function reconcileTasks(state, chapterId, tasks, at = new Date().toISOString()) {
  for (const task of tasks) {
    if (!task.finished) continue;
    const key = taskKey(chapterId, task);
    const { error, reason, ...previous } = state[key] || {};
    state[key] = previous.pendingQuestion
      ? { ...previous, error, reason, taskFinished: true, confirmation: 'online-scan', at }
      : { ...previous, status: 'completed', taskFinished: true, confirmation: 'online-scan', at };
  }
}
module.exports = { isFatal, isTransient, taskKey, reconcileTasks };
