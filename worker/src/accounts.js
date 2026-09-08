// Who an ID belongs to.
//
// One login field serves both roles. Karyakar IDs are K-prefixed so they can
// never collide with a BK ID, which is what makes a single field unambiguous.

import { findRow } from './sheets.js';

const isTrue = (value) => String(value).trim().toLowerCase() === 'true';

export function normalizeId(id) {
  return String(id || '').trim().toUpperCase();
}

export function roleForId(id) {
  return id.startsWith('K') ? 'karyakar' : 'delegate';
}

// Returns null for an unknown or deactivated account. The caller must not tell
// them apart in what it sends back.
export async function lookupAccount(env, id) {
  const role = roleForId(id);
  const row =
    role === 'karyakar'
      ? await findRow(env, 'karyakars', 'karyakar_id', id)
      : await findRow(env, 'delegates', 'bk_id', id);

  if (!row || !isTrue(row.active)) return null;

  return {
    id,
    role,
    firstName: row.first_name,
    lastName: row.last_name,
    name: `${row.first_name} ${row.last_name}`.trim(),
  };
}
