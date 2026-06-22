// NACTA sync (cron target, every 3h).
//   npm run sync:nacta
//
// Why Playwright: nfs.nacta.gov.pk is a Blazor Server app — the "Export Excel"
// button doesn't have a static download URL; clicking it dispatches a SignalR
// event server-side, which builds the file and streams it back via WebSocket.
// We mimic a real user with a headless Chromium browser.
//
// Optimisation: the page shows "Total Results: NNNN" near the top. We scrape
// that first, compare to last_count, and skip the Export click entirely if
// nothing changed. Saves NACTA's server the file build + saves us the parse.
//
// Configurables (via env):
//   NACTA_URL                  default https://nfs.nacta.gov.pk/
//   NACTA_SYNC_TIMEOUT_MS      default 90000
//   NACTA_FORCE_DOWNLOAD       set to '1' to bypass the count-check
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { config } from '../config/env.js';
import { parseNactaExcel } from '../parsers/excelParser.js';
import { ingestNacta } from '../services/listIngestService.js';
import { readState, writeState, runSync } from './_runSync.js';

const URL = process.env.NACTA_URL || 'https://nfs.nacta.gov.pk/';
const TIMEOUT_MS = Number(process.env.NACTA_SYNC_TIMEOUT_MS || 90_000);
const FORCE = process.env.NACTA_FORCE_DOWNLOAD === '1';

/** Open the page, return { browser, page, count } where count is the scraped total. */
async function openAndScrape() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'], // safe defaults for VMs
  });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);

    console.log(`[nacta] navigating to ${URL} ...`);
    // 'networkidle' never fires on Blazor pages because the SignalR WebSocket
    // stays open for the page's lifetime. Use 'domcontentloaded' (early signal)
    // and let the explicit "Total Results:" wait below confirm the app rendered.
    await page.goto(URL, { waitUntil: 'domcontentloaded' });

    // The total count lives in <i class="text-black-50">Total Results: NNNN</i>.
    // Wait until that text appears (Blazor renders it after the table loads).
    await page.locator('text=/Total Results:/i').first().waitFor({ timeout: TIMEOUT_MS });
    const countText = await page.locator('text=/Total Results:/i').first().textContent();
    const match = countText && countText.match(/Total Results:\s*([\d,]+)/i);
    const count = match ? Number(match[1].replace(/,/g, '')) : null;
    if (count === null || Number.isNaN(count)) {
      throw new Error(`Could not parse a number from "${countText}"`);
    }
    console.log(`[nacta] page reports Total Results: ${count}`);
    return { browser, page, count };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

/** Click Export → Excel and return the downloaded file as a Buffer. */
async function exportExcel(page) {
  // The NACTA page typically shows an "Export" button that opens a small menu
  // with "Excel / JSON / XML". We use case-insensitive text matching so the
  // script survives small UI changes.
  console.log('[nacta] clicking Export ...');
  const exportBtn = page.locator('button, a').filter({ hasText: /export/i }).first();
  await exportBtn.click();

  // Wait for the "Excel" option to be visible, then click it AND wait for the
  // download event in a Promise.all (Playwright's recommended pattern).
  console.log('[nacta] selecting Excel ...');
  const excelOption = page.locator('button, a, li, [role="menuitem"]')
    .filter({ hasText: /^\s*excel\s*$/i })
    .first();

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: TIMEOUT_MS }),
    excelOption.click(),
  ]);

  const tmpPath = await download.path();
  if (!tmpPath) throw new Error('Playwright returned no download path');
  const buf = await fs.readFile(tmpPath);
  console.log(`[nacta] downloaded ${buf.length.toLocaleString()} bytes`);
  return buf;
}

await runSync('nacta', async () => {
  const { browser, page, count } = await openAndScrape();
  try {
    // Skip-if-unchanged guard.
    if (!FORCE) {
      const state = await readState('nacta');
      if (state.last_count !== null && state.last_count === count) {
        return { outcome: 'unchanged', reason: `count unchanged at ${count}` };
      }
    }

    const buf = await exportExcel(page);

    console.log('[nacta] parsing Excel ...');
    const { records, skipped, warnings } = parseNactaExcel(buf);
    if (records.length === 0) throw new Error('NACTA Excel parsed to zero records');

    const userId = Number(process.env.LIST_SYNC_USER_ID || config.seed?.userId || 1);
    console.log(`[nacta] ingesting ${records.length.toLocaleString()} records ...`);
    const result = await ingestNacta({
      records,
      filename: `auto-sync@${new Date().toISOString()}`,
      userId,
    });

    await writeState('nacta', { last_count: count });

    return {
      outcome: 'success',
      delta: {
        ...result.stats,
        page_count: count,
        skipped_rows: skipped,
        warnings_count: warnings.length,
      },
    };
  } finally {
    await browser.close();
  }
});
