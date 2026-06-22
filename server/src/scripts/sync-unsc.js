// UNSC daily sync (cron target).
//   npm run sync:unsc
//
// Flow:
//   1. Fetch the official UN consolidated XML feed.
//   2. Hash the body (SHA-256). Skip ingest if it matches last_signature.
//   3. Otherwise parse + ingest via the shared listIngestService (dedup logic).
//   4. Persist the new signature + write a sync_log row.
//
// The default URL is the documented stable UN endpoint; override via UNSC_URL.
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { parseUnscXml } from '../parsers/unscXmlParser.js';
import { ingestUnsc } from '../services/listIngestService.js';
import { readState, writeState, runSync } from './_runSync.js';

const URL = process.env.UNSC_URL ||
  'https://scsanctions.un.org/resources/xml/en/consolidated.xml';
const TIMEOUT_MS = 60_000;

async function fetchXml(url) {
  // Node 18+ has fetch built-in. Follow redirects (the UN endpoint 302s to
  // a signed Azure blob URL on every request).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'compliance-portal/1.0 (UNSC daily sync)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

await runSync('unsc', async () => {
  console.log(`[unsc] fetching ${URL} ...`);
  const buf = await fetchXml(URL);
  const signature = sha256(buf);

  const state = await readState('unsc');
  if (state.last_signature && state.last_signature === signature) {
    return { outcome: 'unchanged', reason: 'feed unchanged (hash match)' };
  }

  console.log(`[unsc] parsing ${buf.length.toLocaleString()} bytes ...`);
  const { records, parseErrors, warnings } = parseUnscXml(buf);
  if (records.length === 0) {
    throw new Error('UNSC XML parsed to zero records');
  }

  // For cron-driven runs, attribute the upload to the seeded officer (id=1).
  // Override via LIST_SYNC_USER_ID env var if you have a dedicated 'system' user.
  const userId = Number(process.env.LIST_SYNC_USER_ID || config.seed?.userId || 1);

  console.log(`[unsc] ingesting ${records.length.toLocaleString()} records ...`);
  const result = await ingestUnsc({
    records,
    filename: `auto-sync@${new Date().toISOString()}`,
    userId,
  });

  await writeState('unsc', { last_signature: signature });

  return {
    outcome: 'success',
    delta: {
      ...result.stats,
      parse_errors: parseErrors,
      warnings_count: warnings.length,
    },
  };
});
