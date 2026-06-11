// Date formatting helpers. Reports and version labels use a human "19 May 2025"
// style. PKT (UTC+5) is Pakistan's fixed offset (no DST) — fine for display.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toPkt(date) {
  const d = date instanceof Date ? date : new Date(date);
  // Shift to UTC+5 by working off the UTC fields.
  return new Date(d.getTime() + 5 * 60 * 60 * 1000);
}

/** "19 May 2025" */
export function formatDate(date) {
  const d = toPkt(date);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "22 May 2025, 14:32 PKT" */
export function formatDateTime(date) {
  const d = toPkt(date);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${formatDate(date)}, ${hh}:${mm} PKT`;
}

/** "v1.3 – uploaded 19 May 2025" (stored on the screening for audit). */
export function versionStamp(label, uploadedAt) {
  return `${label} – uploaded ${formatDate(uploadedAt)}`;
}
