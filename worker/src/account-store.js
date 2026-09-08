// Per-account credential and lockout state.
//
// One Durable Object per ID. Durable Objects are strongly consistent and
// serialize the requests they receive, which is what a failed-attempt counter
// needs — KV is eventually consistent, so concurrent increments there
// overwrite each other and the lockout never trips.
//
// Nothing here reaches the Sheet. A hashed 4-digit PIN in a spreadsheet is
// recoverable by anyone who can open that spreadsheet.

import { DurableObject } from 'cloudflare:workers';

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export class Account extends DurableObject {
  async #read() {
    return {
      pinHash: (await this.ctx.storage.get('pinHash')) || null,
      attempts: (await this.ctx.storage.get('attempts')) || 0,
      lockedUntil: (await this.ctx.storage.get('lockedUntil')) || 0,
    };
  }

  async load() {
    const state = await this.#read();
    const locked = state.lockedUntil > Date.now();
    return {
      hasPin: Boolean(state.pinHash),
      pinHash: state.pinHash,
      locked,
      minutesLeft: locked
        ? Math.max(1, Math.ceil((state.lockedUntil - Date.now()) / 60000))
        : 0,
    };
  }

  // Refuses to overwrite an existing PIN. Replacing one is a karyakar reset.
  async setPin(pinHash) {
    if (await this.ctx.storage.get('pinHash')) return { alreadySet: true };
    await this.ctx.storage.put({ pinHash, attempts: 0, lastFailureAt: 0, lockedUntil: 0 });
    return { alreadySet: false };
  }

  async resetPin() {
    await this.ctx.storage.delete(['pinHash', 'attempts', 'lastFailureAt', 'lockedUntil']);
  }

  // Failed attempts decay. Without this the count only ever climbs, so once
  // someone had been locked out, every later typo would lock them again for
  // fifteen minutes for the rest of the year.
  async recordFailure() {
    const now = Date.now();
    const lastAt = (await this.ctx.storage.get('lastFailureAt')) || 0;
    const stale = now - lastAt > LOCKOUT_MS;
    const attempts = (stale ? 0 : (await this.ctx.storage.get('attempts')) || 0) + 1;
    const locked = attempts >= MAX_ATTEMPTS;
    await this.ctx.storage.put({
      attempts,
      lastFailureAt: now,
      lockedUntil: locked ? now + LOCKOUT_MS : 0,
    });
    return { attempts, remaining: Math.max(0, MAX_ATTEMPTS - attempts), locked };
  }

  async clearFailures() {
    await this.ctx.storage.put({ attempts: 0, lastFailureAt: 0, lockedUntil: 0 });
  }
}

export function accountStore(env, id) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(id));
}
