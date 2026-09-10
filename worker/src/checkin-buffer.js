// The check-in buffer.
//
// Twenty-five delegates tapping check-in at once means twenty-five writes to
// one spreadsheet, and Google serialises writes per spreadsheet. Measured, it
// took minutes and seven people got nothing at all.
//
// So a check-in is not written to the Sheet by the request that made it. It is
// recorded durably here first — which is fast, and which is what lets the
// delegate's phone answer immediately — and this object flushes everything it
// has collected to the Sheet in a single append a second later.
//
// Twenty-five writes become one. If the flush fails, the rows are still here
// and the next alarm tries again, so a check-in cannot be lost to a bad moment
// on Google's side.

import { DurableObject } from 'cloudflare:workers';
import { appendRows } from './sheets.js';

const FLUSH_AFTER_MS = 1000;
const RETRY_AFTER_MS = 5000;

export class CheckinBuffer extends DurableObject {
  // The window state lives here as well as in the Sheet.
  //
  // Read from the Sheet it comes through a cache that lives in one isolate, so
  // opening check-in cleared it for one request and the other twenty-nine read
  // a copy that still said closed. Measured: twenty-three of thirty delegates
  // told check-in was not open, seconds after a karyakar opened it.
  //
  // This object is one per session and strongly consistent, so what it says is
  // true everywhere at once. The Sheet remains the record; this is the answer.
  async setWindow(state) {
    await this.ctx.storage.put('checkin_state', state);
    return { ok: true };
  }

  async windowState() {
    return (await this.ctx.storage.get('checkin_state')) || null;
  }

  // Durable before the delegate is told it worked. A row here is a check-in
  // that has happened, whether or not the Sheet knows yet.
  async queue(row) {
    const key = `pending:${Date.now()}:${crypto.randomUUID()}`;
    await this.ctx.storage.put(key, row);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_AFTER_MS);
    }
    return { ok: true };
  }

  // Rows waiting to reach the Sheet, so a roster read a second after a rush
  // still shows everyone who tapped.
  async pending() {
    const stored = await this.ctx.storage.list({ prefix: 'pending:' });
    return [...stored.values()];
  }

  async alarm() {
    const stored = await this.ctx.storage.list({ prefix: 'pending:' });
    if (!stored.size) return;

    const keys = [...stored.keys()];
    const rows = [...stored.values()];

    try {
      await appendRows(this.env, 'attendance', rows);
    } catch (error) {
      // Left in place on purpose: a failed flush must not lose a check-in.
      console.error('checkin flush failed, will retry', error.message);
      await this.ctx.storage.setAlarm(Date.now() + RETRY_AFTER_MS);
      return;
    }

    await this.ctx.storage.delete(keys);

    // Anything that arrived while that was in flight gets its own flush.
    const left = await this.ctx.storage.list({ prefix: 'pending:', limit: 1 });
    if (left.size) await this.ctx.storage.setAlarm(Date.now() + FLUSH_AFTER_MS);
  }
}

export function checkinBuffer(env, sessionId) {
  return env.CHECKINS.get(env.CHECKINS.idFromName(sessionId));
}
