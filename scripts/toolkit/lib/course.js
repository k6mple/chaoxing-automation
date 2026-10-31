const path = require('node:path');
const config = require('../config');
const { readJson } = require('./store');

function courseUrl(course) {
  const query = new URLSearchParams({ courseid: course.courseId, clazzid: course.clazzId, cpi: course.cpi, enc: course.enc, pageHeader: '1', v: '2', hideHead: '0' });
  if (course.t) query.set('t', course.t);
  return `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?${query}`;
}

function resolveCourse(input) {
  if (!input) throw new Error('请指定课程 key 或课程 URL');
  let course;
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input.replace(/\\&/g, '&'));
    if (!/(^|\.)chaoxing\.com$/.test(url.hostname)) throw new Error('课程 URL 必须来自 chaoxing.com');
    const get = (...keys) => keys.map(k => url.searchParams.get(k)).find(Boolean);
    course = { courseId: get('courseid', 'courseId'), clazzId: get('clazzid', 'clazzId'), cpi: get('cpi'), enc: get('enc'), t: get('t'), name: get('name') || '' };
  } else {
    course = readJson(path.join(config.data, 'courses.json'), {})[input];
    if (!course) throw new Error(`未知课程：${input}`);
    course = { ...course, key: input };
  }
  for (const field of ['courseId', 'clazzId', 'cpi']) if (!/^\d+$/.test(String(course[field]))) throw new Error(`课程缺少有效 ${field}`);
  if (!course.enc) throw new Error('课程缺少 enc，请从浏览器复制新的课程 URL');
  return course;
}

module.exports = { courseUrl, resolveCourse };
