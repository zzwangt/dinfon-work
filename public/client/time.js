/** Shared scheduling times use Shanghai (UTC+08:00), never the browser's zone. */
const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function parse(value) {
  if (typeof value !== 'string' || !(DATE.test(value) || LOCAL.test(value) || ISO.test(value))) return null;
  const date = value.slice(0, 10);
  const calendar = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date) return null;
  if (DATE.test(value)) return { date, dateOnly: true, local: true, ms: Date.parse(`${date}T00:00:00+08:00`) };
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59) return null;
  const local = LOCAL.test(value);
  if (!local) {
    const seconds = value.match(/T\d{2}:\d{2}:(\d{2})/);
    const offset = value.match(/[+-](\d{2}):(\d{2})$/);
    if ((seconds && Number(seconds[1]) > 59) || (offset && (Number(offset[1]) > 23 || Number(offset[2]) > 59))) return null;
  }
  const ms = Date.parse(local ? `${value}:00+08:00` : value);
  return Number.isFinite(ms) ? { date, dateOnly: false, local, ms } : null;
}

function shanghaiLocal(ms) {
  const value = new Date(ms + SHANGHAI_OFFSET_MS);
  return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 16) : '';
}

export function validSchedule(value, label = '日期') {
  if (parse(value)) return value;
  const shaped = typeof value === 'string' && (DATE.test(value) || LOCAL.test(value) || ISO.test(value));
  throw new Error(`${label}${shaped ? '无效' : '格式不正确'}`);
}

export function datePart(value) {
  const parsed = parse(value);
  if (!parsed) return '';
  return parsed.local ? parsed.date : shanghaiLocal(parsed.ms).slice(0, 10);
}

export function deadlineMs(value) {
  const parsed = parse(value);
  if (!parsed) return NaN;
  return parsed.ms + (parsed.dateOnly ? DAY_MS - 1 : 0);
}

export function startMs(value) {
  return parse(value)?.ms ?? NaN;
}

export function isOverdue(value, now = Date.now()) {
  const deadline = deadlineMs(value);
  return Number.isFinite(deadline) && Number.isFinite(now) && deadline < now;
}

export function formatDateTime(value, { compact = false, legacyLabel = true } = {}) {
  const parsed = parse(value);
  if (!parsed) return '—';
  const local = parsed.local ? value : shanghaiLocal(parsed.ms);
  const date = compact ? `${Number(local.slice(5, 7))}/${Number(local.slice(8, 10))}` : local.slice(0, 10).replaceAll('-', '.');
  return parsed.dateOnly ? `${date}${legacyLabel ? ' 全天' : ''}` : `${date} ${local.slice(11, 16)}`;
}

export function toDateTimeInput(value, defaultHour = '18:00') {
  const parsed = parse(value);
  if (!parsed) return '';
  if (parsed.dateOnly) {
    const input = `${value}T${defaultHour}`;
    return LOCAL.test(input) && parse(input) ? input : '';
  }
  return parsed.local ? value : shanghaiLocal(parsed.ms);
}
