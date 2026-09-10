// How a name is shown.
//
// Delegates and karyakars are addressed with bhai attached to the first name,
// which is how anyone in the mandal would say it aloud. The Sheet holds the
// plain name; this is a display decision, so it lives here rather than being
// typed into the roster twenty-five times.
//
// It never doubles up. Whether the Sheet says Dhruv, Dhruvbhai, Dhruv bhai or
// DHRUVBHAI, what comes out is Dhruvbhai.

const SUFFIX = 'bhai';

export function withBhai(first) {
  const name = String(first || '').trim();
  if (!name) return '';

  // Strip any bhai already there, with or without a space, in any case.
  const stripped = name.replace(/\s*bhai\s*$/i, '').trim();
  if (!stripped) return name;

  return tidyCase(stripped) + SUFFIX;
}

// DHRUVBHAI should not come out as DHRUVbhai, and dhruv should not come out as
// dhruvbhai. But a name someone capitalised on purpose is left alone: only a
// name that is entirely upper or entirely lower case is being shouted or
// mumbled rather than spelled.
function tidyCase(name) {
  const hasLower = /[a-z]/.test(name);
  const hasUpper = /[A-Z]/.test(name);
  if (hasLower && hasUpper) return name;
  return name
    .split(/(\s+|-)/)
    .map((part) =>
      /^[\s-]*$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    )
    .join('');
}

export function fullName(first, last) {
  return [withBhai(first), String(last || '').trim()].filter(Boolean).join(' ');
}
