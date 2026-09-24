// Frontend date formatting. Always renders in Pakistan time (Asia/Karachi,
// UTC+5, no DST) regardless of the browser's local timezone — so a compliance
// officer opening the portal from any machine sees PKT-consistent timestamps.

const FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** "21/07/2026, 14:32" — always Asia/Karachi. Empty string for null/invalid. */
export function formatPkt(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${FMT.format(d)} PKT`;
}
