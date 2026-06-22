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
// 3-minute default: the Blazor SignalR data load can be slow over long-haul links.
const TIMEOUT_MS = Number(process.env.NACTA_SYNC_TIMEOUT_MS || 180_000);
const FORCE = process.env.NACTA_FORCE_DOWNLOAD === '1';
const DEBUG_DIR = '/tmp';

/** Write the failed page state to /tmp for diagnosis. Best-effort — swallows errors. */
async function dumpFailure(page, tag) {
  try {
    const ts = Date.now();
    const png = `${DEBUG_DIR}/nacta-${tag}-${ts}.png`;
    const html = `${DEBUG_DIR}/nacta-${tag}-${ts}.html`;
    await page.screenshot({ path: png, fullPage: true });
    await fs.writeFile(html, await page.content());
    console.error(`[nacta] debug artefacts written: ${png} / ${html}`);
  } catch {
    /* ignore — diagnosis only */
  }
}

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

    // Log page-level errors + console errors so we can see SignalR/Blazor issues.
    page.on('pageerror', (e) => console.error('[nacta] PAGE ERROR:', e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') console.error('[nacta] PAGE CONSOLE ERROR:', m.text());
    });
    page.on('requestfailed', (req) =>
      console.error(`[nacta] REQUEST FAILED: ${req.url()} -- ${req.failure()?.errorText}`),
    );

    console.log(`[nacta] navigating to ${URL} ...`);
    // 'networkidle' never fires on Blazor pages because the SignalR WebSocket
    // stays open for the page's lifetime. Use 'domcontentloaded' (early signal)
    // and explicitly wait for the data-loaded signals below.
    await page.goto(URL, { waitUntil: 'domcontentloaded' });

    // The Blazor app renders the chrome immediately (Total Results: 0 + disabled
    // EXPORT button) and then async-fetches records over SignalR. We wait for
    // BOTH "data is ready" signals: Export enabled + count > 0.
    //
    // We poll manually instead of using waitForFunction so we can print progress
    // — silent 3-minute hangs are the worst kind to debug.
    console.log('[nacta] waiting for Blazor data load (Export enabled + count > 0) ...');
    const t0 = Date.now();
    let snapshot = { count: 0, exportEnabled: false };
    while (Date.now() - t0 < TIMEOUT_MS) {
      snapshot = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(
          (b) => /export/i.test(b.textContent || ''),
        );
        const exportEnabled = !!btn && !btn.disabled && !btn.classList.contains('disabled');
        const countEl = Array.from(document.querySelectorAll('i, span, div'))
          .find((e) => /total results:/i.test(e.textContent || ''));
        let count = 0;
        if (countEl) {
          const m = countEl.textContent.match(/Total Results:\s*([\d,]+)/i);
          if (m) count = Number(m[1].replace(/,/g, ''));
        }
        return { count, exportEnabled };
      });
      if (snapshot.exportEnabled && snapshot.count > 0) break;
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`[nacta]   still waiting (${elapsed}s) — count=${snapshot.count}, export-enabled=${snapshot.exportEnabled}`);
      await page.waitForTimeout(10_000);
    }
    if (!snapshot.exportEnabled || snapshot.count === 0) {
      await dumpFailure(page, 'data-load');
      throw new Error(
        `Blazor data load did not complete within ${TIMEOUT_MS}ms ` +
          `(last snapshot: count=${snapshot.count}, export-enabled=${snapshot.exportEnabled}). ` +
          `See /tmp/nacta-data-load-*.png for the page state.`,
      );
    }

    const countText = await page.locator('text=/Total Results:/i').first().textContent();
    const match = countText && countText.match(/Total Results:\s*([\d,]+)/i);
    const count = match ? Number(match[1].replace(/,/g, '')) : null;
    if (count === null || Number.isNaN(count) || count === 0) {
      throw new Error(`Could not parse a non-zero count from "${countText}"`);
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
  // The NACTA page shows an "Export" button (now enabled, since openAndScrape
  // waited for the data load). Clicking it opens a small menu with Excel/JSON/XML.
  // We scroll into view + force-click to bypass any overlay from the adjacent
  // pagination control that's intercepting pointer events during layout settle.
  console.log('[nacta] clicking Export ...');
  const exportBtn = page.locator('button').filter({ hasText: /export/i }).first();
  await exportBtn.scrollIntoViewIfNeeded();
  await exportBtn.click({ force: true });

  console.log('[nacta] selecting Excel ...');
  const excelOption = page.locator('button, a, li, [role="menuitem"]')
    .filter({ hasText: /^\s*excel\s*$/i })
    .first();
  await excelOption.waitFor({ state: 'visible', timeout: TIMEOUT_MS });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: TIMEOUT_MS }),
    excelOption.click({ force: true }),
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
