// Adding and removing people.
//
// Restricted to a karyakar whose admin column says TRUE, checked here on every
// request rather than by hiding a button. A hidden button is not a permission.
//
// Removing never deletes. Section 3 gives every delegate an active column for
// exactly this: setting it false takes them off every roster and stops them
// signing in, while their attendance stays in the ledger. Deleting the row
// would leave those rows pointing at nobody and quietly erase any absence they
// had spent.

import { readTab, appendRows, updateRowWhere } from './sheets.js';
import { fullName } from './names.js';

const isTrue = (value) => String(value).trim().toLowerCase() === 'true';

export async function isAdmin(env, karyakarId) {
  const rows = await readTab(env, 'karyakars', { fresh: true });
  const row = rows.find((r) => r.karyakar_id === karyakarId);
  return Boolean(row && isTrue(row.active) && isTrue(row.admin));
}

const CENTERS = ['Birmingham', 'Dothan', 'Huntsville', 'Mobile', 'Montgomery'];

export async function addDelegate(env, entry) {
  const id = String(entry.bkId || '').trim();
  if (!/^\d{1,10}$/.test(id)) return { error: 'A BK ID is digits only.' };
  if (!String(entry.firstName || '').trim()) return { error: 'A first name is needed.' };
  if (!String(entry.lastName || '').trim()) return { error: 'A last name is needed.' };
  if (!CENTERS.includes(entry.center)) return { error: 'Pick a centre.' };
  if (!['9', '10', '11', '12'].includes(String(entry.grade))) {
    return { error: 'A grade of 9 to 12 is needed.' };
  }

  const rows = await readTab(env, 'delegates', { fresh: true });
  const existing = rows.find((row) => row.bk_id === id);
  if (existing) {
    return isTrue(existing.active)
      ? { error: 'That BK ID is already on the roster.' }
      : { error: 'That BK ID was removed earlier. Bring them back instead of adding them again.' };
  }

  const term = rows.find((row) => row.term_group)?.term_group || '';
  await appendRows(env, 'delegates', [
    {
      bk_id: id,
      first_name: String(entry.firstName).trim(),
      last_name: String(entry.lastName).trim(),
      grade: String(entry.grade),
      center: entry.center,
      term_group: term,
      active: 'TRUE',
      notes: '',
    },
  ]);
  return { ok: true, name: fullName(entry.firstName, entry.lastName) };
}

export async function addKaryakar(env, entry) {
  const id = String(entry.karyakarId || '').trim().toUpperCase();
  // K-prefixed, because that prefix is what tells the login which tab to look
  // in. A karyakar id that looked like a BK ID would be unreachable.
  if (!/^K\d{1,6}$/.test(id)) return { error: 'A karyakar ID looks like K003.' };
  if (!String(entry.firstName || '').trim()) return { error: 'A first name is needed.' };
  if (!String(entry.lastName || '').trim()) return { error: 'A last name is needed.' };

  const rows = await readTab(env, 'karyakars', { fresh: true });
  const existing = rows.find((row) => row.karyakar_id === id);
  if (existing) {
    return isTrue(existing.active)
      ? { error: 'That karyakar ID is already in use.' }
      : { error: 'That ID was removed earlier. Bring them back instead of adding them again.' };
  }

  await appendRows(env, 'karyakars', [
    {
      karyakar_id: id,
      first_name: String(entry.firstName).trim(),
      last_name: String(entry.lastName).trim(),
      active: 'TRUE',
      created_at: new Date().toISOString().slice(0, 10),
      admin: 'FALSE',
    },
  ]);
  return { ok: true, name: fullName(entry.firstName, entry.lastName) };
}

export async function setActive(env, kind, id, active, actorId) {
  const tab = kind === 'karyakar' ? 'karyakars' : 'delegates';
  const key = kind === 'karyakar' ? 'karyakar_id' : 'bk_id';

  const rows = await readTab(env, tab, { fresh: true });
  const row = rows.find((r) => r[key] === id);
  if (!row) return { error: 'No such person.' };

  // The last way in must stay open. An admin removing themselves, or the last
  // karyakar being removed, would leave nobody able to open check-in or reset
  // a PIN, and no way back except editing the sheet.
  if (kind === 'karyakar' && !active) {
    if (id === actorId) return { error: 'You cannot remove yourself.' };
    const others = rows.filter((r) => r.karyakar_id !== id && isTrue(r.active));
    if (!others.length) return { error: 'That is the last karyakar. Add another first.' };
    if (isTrue(row.admin) && !others.some((r) => isTrue(r.admin))) {
      return { error: 'That is the last admin. Make someone else an admin first.' };
    }
  }

  await updateRowWhere(env, tab, key, id, { active: active ? 'TRUE' : 'FALSE' });
  console.log(
    JSON.stringify({
      event: active ? 'restored' : 'removed',
      kind,
      id,
      by: actorId,
      at: new Date().toISOString(),
    })
  );
  return { ok: true, name: fullName(row.first_name, row.last_name) };
}

// Everyone currently switched off, so someone removed by mistake can be found.
export async function removedPeople(env) {
  const [delegates, karyakars] = await Promise.all([
    readTab(env, 'delegates'),
    readTab(env, 'karyakars'),
  ]);
  return {
    delegates: delegates
      .filter((row) => row.bk_id && !isTrue(row.active))
      .map((row) => ({ id: row.bk_id, name: fullName(row.first_name, row.last_name) })),
    karyakars: karyakars
      .filter((row) => row.karyakar_id && !isTrue(row.active))
      .map((row) => ({ id: row.karyakar_id, name: fullName(row.first_name, row.last_name) })),
  };
}
