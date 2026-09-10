// The three-day programme: what happens when, and when people eat.
//
// Meals are not kept apart from everything else. A delegate on Saturday
// morning wants to know what is happening and when they eat, and those are the
// same question; separating them would mean checking two screens to plan one
// day. A meal is just an item with a flag, shown differently.
//
// Days are stored as 1, 2 or 3 rather than as dates, so nobody retypes dates
// that the session already knows. Cue numbers and total time are not stored
// either: one is row order, the other is end minus start.

import { readTab, appendRows, updateRowWhere, updateRowsWhere } from './sheets.js';

const TAB = 'schedule';
const DAYS = [1, 2, 3];

const isTrue = (value) => String(value).trim().toLowerCase() === 'true';

// "18:30" sorts; anything else is left alone so a karyakar typing "6:30 PM"
// into the sheet still gets something sensible.
function sortKey(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  if (!match) return 9999;
  return Number(match[1]) * 60 + Number(match[2]);
}

function displayTime(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  if (!match) return String(time || '');
  const hour = Number(match[1]);
  const suffix = hour < 12 ? 'AM' : 'PM';
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${shown}:${match[2]} ${suffix}`;
}

// End minus start, shown as 1:00 or 0:30. Blank when a thing has no end, like
// lights out.
function duration(start, end) {
  const a = sortKey(start);
  const b = sortKey(end);
  if (a === 9999 || b === 9999 || b <= a) return '';
  const minutes = b - a;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

// Day one of a session is its start date; the rest follow it.
function dateForDay(startDate, day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startDate || ''));
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + (day - 1))
  );
  return date;
}

function dayLabel(startDate, day) {
  const date = dateForDay(startDate, day);
  if (!date) return `Day ${day}`;
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export async function scheduleFor(env, session) {
  const rows = await readTab(env, TAB);
  const mine = rows.filter((row) => row.session_id === session.session_id);

  const days = DAYS.map((day) => {
    const items = mine
      .filter((row) => Number(row.day) === day)
      .sort((a, b) => sortKey(a.start_time) - sortKey(b.start_time))
      .map((row) => ({
        id: row.schedule_id,
        day,
        time: displayTime(row.start_time),
        endTime: displayTime(row.end_time),
        rawTime: row.start_time,
        rawEndTime: row.end_time,
        duration: duration(row.start_time, row.end_time),
        item: row.item,
        presenter: row.presenter,
        location: row.location,
        isMeal: isTrue(row.is_meal),
        note: row.note,
      }));
    return { day, label: dayLabel(session.session_date, day), items };
  });

  return {
    sessionId: session.session_id,
    startDate: session.session_date,
    endDate: session.session_end_date,
    location: session.location,
    days,
    empty: days.every((d) => !d.items.length),
  };
}

export function itemProblem(entry) {
  if (!entry) return 'Nothing to add.';
  if (!DAYS.includes(Number(entry.day))) return 'A day of 1, 2 or 3 is needed.';
  if (!String(entry.item || '').trim()) return 'Say what is happening.';
  if (String(entry.item).length > 200) return 'Keep it under 200 characters.';
  if (!/^\d{1,2}:\d{2}$/.test(String(entry.time || '').trim())) {
    return 'A start time like 08:30 or 19:00 is needed.';
  }
  const end = String(entry.endTime || '').trim();
  if (end && !/^\d{1,2}:\d{2}$/.test(end)) {
    return 'An end time like 09:00, or leave it blank.';
  }
  return null;
}

function fields(entry) {
  return {
    day: String(Number(entry.day)),
    start_time: String(entry.time || '').trim(),
    end_time: String(entry.endTime || '').trim(),
    item: String(entry.item).trim(),
    presenter: String(entry.presenter || '').trim(),
    location: String(entry.location || '').trim(),
    is_meal: entry.isMeal ? 'TRUE' : 'FALSE',
    note: String(entry.note || '').trim(),
  };
}

export async function addItem(env, sessionId, entry) {
  await appendRows(env, TAB, [
    { schedule_id: crypto.randomUUID(), session_id: sessionId, ...fields(entry) },
  ]);
}

export async function editItem(env, id, entry) {
  await updateRowWhere(env, TAB, 'schedule_id', id, fields(entry));
}

// Emptied rather than deleted: removing a row shifts every row below it, and
// the sheet is something people have open while the app is writing to it.
export async function removeItem(env, id) {
  await updateRowWhere(env, TAB, 'schedule_id', id, {
    session_id: '',
    day: '',
    start_time: '',
    end_time: '',
    item: '',
    presenter: '',
    location: '',
    is_meal: '',
    note: '',
  });
}


function addMinutes(time, minutes) {
  const base = sortKey(time);
  if (base === 9999) return time;
  const total = ((base + minutes) % 1440 + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Which items a shift would move, without moving them. The screen shows this
// before anything is written, because a schedule someone typed by hand should
// never be rewritten in bulk without them seeing what is about to happen.
export async function shiftPreview(env, sessionId, day, afterTime, includeAnchor) {
  const rows = await readTab(env, TAB);
  const anchor = sortKey(afterTime);
  return rows
    .filter((row) => row.session_id === sessionId && Number(row.day) === Number(day))
    .filter((row) => {
      const at = sortKey(row.start_time);
      return includeAnchor ? at >= anchor : at > anchor;
    })
    .sort((a, b) => sortKey(a.start_time) - sortKey(b.start_time))
    .map((row) => ({ ...row, shown: displayTime(row.start_time) }));
}

export async function shiftFrom(env, sessionId, day, afterTime, includeAnchor, minutes) {
  const moving = await shiftPreview(env, sessionId, day, afterTime, includeAnchor);
  if (!moving.length || !minutes) return 0;

  return updateRowsWhere(
    env,
    TAB,
    'schedule_id',
    moving.map((row) => ({
      key: row.schedule_id,
      patch: {
        start_time: addMinutes(row.start_time, minutes),
        end_time: row.end_time ? addMinutes(row.end_time, minutes) : '',
      },
    }))
  );
}
