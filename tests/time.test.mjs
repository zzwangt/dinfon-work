import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { datePart, deadlineMs, startMs, isOverdue, formatDateTime, toDateTimeInput, validSchedule } from '../public/client/time.js';

test('Shanghai local deadlines and explicit offsets identify the same real instant', () => {
  const expected = Date.parse('2026-10-22T02:00:00Z');
  for (const value of ['2026-10-22T10:00', '2026-10-22T10:00+08:00', '2026-10-22T02:00:00Z', '2026-10-21T22:00:00-04:00']) {
    assert.equal(validSchedule(value), value);
    assert.equal(deadlineMs(value), expected);
    assert.equal(startMs(value), expected);
    assert.equal(datePart(value), '2026-10-22');
  }
});

test('legacy dates span their entire Shanghai calendar day without inventing an hour', () => {
  const date = '2026-10-25';
  assert.equal(startMs(date), Date.parse('2026-10-24T16:00:00Z'));
  assert.equal(deadlineMs(date), Date.parse('2026-10-25T15:59:59.999Z'));
  assert.equal(deadlineMs(date) - startMs(date), 86400000 - 1);
  assert.equal(isOverdue(date, deadlineMs(date)), false);
  assert.equal(isOverdue(date, deadlineMs(date) + 1), true);
  assert.equal(formatDateTime(date), '2026.10.25 全天');
  assert.equal(formatDateTime(date, { compact: true }), '10/25 全天');
  assert.equal(formatDateTime(date, { legacyLabel: false }), '2026.10.25');
  assert.equal(formatDateTime(date, { compact: true, legacyLabel: false }), '10/25');
});

test('strict calendar and clock validation rejects rollover, malformed offsets and ambiguous local seconds', () => {
  assert.equal(validSchedule('2024-02-29T23:59'), '2024-02-29T23:59');
  for (const value of ['2026-02-29', '2026-04-31T18:00', '2026-10-22T24:00', '2026-10-22T09:60', '2026-10-22T09:00:60Z', '2026-10-22T09:00:00+24:00', '2026-10-22T09:00:00+08:60']) {
    assert.throws(() => validSchedule(value, '截止时间'), /截止时间无效/);
    assert.ok(Number.isNaN(deadlineMs(value)));
  }
  for (const value of [null, undefined, '', '2026-1-22', '2026-10-22 09:00', '2026-10-22T09:00:00', '2026-10-22T09:00Zjunk']) {
    assert.throws(() => validSchedule(value, '截止时间'), /截止时间格式不正确/);
  }
});

test('date attribution and display convert UTC and offsets across Shanghai midnight', () => {
  assert.equal(datePart('2026-10-25T15:59:59.999Z'), '2026-10-25');
  assert.equal(datePart('2026-10-25T16:00:00Z'), '2026-10-26');
  assert.equal(formatDateTime('2026-10-25T16:00:00Z'), '2026.10.26 00:00');
  assert.equal(formatDateTime('2026-01-02T02:00:00+09:00', { compact: true }), '1/2 01:00');
  assert.equal(formatDateTime('2026-10-25T09:00'), '2026.10.25 09:00');
});

test('input conversion only adds the caller-selected hour to legacy dates', () => {
  assert.equal(toDateTimeInput('2026-10-25'), '2026-10-25T18:00');
  assert.equal(toDateTimeInput('2026-10-25', '23:00'), '2026-10-25T23:00');
  assert.equal(toDateTimeInput('2026-10-25T09:00', '23:00'), '2026-10-25T09:00');
  assert.equal(toDateTimeInput('2026-10-25T16:00:00Z'), '2026-10-26T00:00');
  assert.equal(toDateTimeInput('2026-10-25', '24:00'), '');
});

test('read helpers tolerate missing and invalid history but validation remains explicit', () => {
  for (const value of ['', undefined, null, 'not-a-date', '2026-02-30']) {
    assert.equal(datePart(value), '');
    assert.equal(formatDateTime(value), '—');
    assert.equal(toDateTimeInput(value), '');
    assert.equal(isOverdue(value), false);
    assert.ok(Number.isNaN(deadlineMs(value)));
    assert.ok(Number.isNaN(startMs(value)));
  }
});

test('schedule parsing and display are independent of the Node process time zone', () => {
  const source = `import {deadlineMs,datePart,formatDateTime,toDateTimeInput} from ${JSON.stringify(new URL('../public/client/time.js', import.meta.url).href)}; console.log(JSON.stringify([deadlineMs('2026-10-25T10:00'),deadlineMs('2026-10-25'),datePart('2026-10-25T16:00:00Z'),formatDateTime('2026-10-25T10:00'),toDateTimeInput('2026-10-25T16:00:00Z')]));`;
  const results = ['UTC', 'America/Los_Angeles', 'Asia/Shanghai'].map((TZ) => execFileSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, TZ }, encoding: 'utf8' }));
  assert.equal(results[0], results[1]);
  assert.equal(results[1], results[2]);
});
