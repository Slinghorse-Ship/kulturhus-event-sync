import http from 'node:http';
import { access, rm } from 'node:fs/promises';
import serverlessChromium from '@sparticuz/chromium';
import { chromium } from 'playwright-core';

const port = Number.parseInt(process.env.PORT || '3000', 10);
const configuredSlug = (process.env.FACEBOOK_PAGE_SLUG || 'kulturhusjaderberg').trim();
const isOneShot = process.argv.includes('--scrape-once');

function json(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function browserInstance() {
  const usesSystemChromium = Boolean(process.env.CHROMIUM_PATH)
    || process.env.GITHUB_ACTIONS === 'true';
  if (!usesSystemChromium) {
    process.env.AWS_EXECUTION_ENV ||= 'AWS_Lambda_nodejs22.x';
    serverlessChromium.setGraphicsMode = false;
    await access('/tmp/al2023/lib/libnspr4.so').catch(() =>
      rm('/tmp/chromium', { force: true }),
    );
  }
  const executablePath = usesSystemChromium
    ? (process.env.CHROMIUM_PATH || chromium.executablePath())
    : await serverlessChromium.executablePath();
  if (!usesSystemChromium) {
    const libraryPath = '/tmp/al2023/lib';
    const existingLibraryPath = process.env.LD_LIBRARY_PATH || '';
    if (!existingLibraryPath.split(':').includes(libraryPath)) {
      process.env.LD_LIBRARY_PATH = [libraryPath, existingLibraryPath]
        .filter(Boolean)
        .join(':');
    }
    process.env.FONTCONFIG_PATH ||= '/tmp/fonts';
  }
  return chromium.launch({
    headless: true,
    executablePath,
    args: usesSystemChromium
      ? ['--disable-dev-shm-usage', '--no-sandbox', '--disable-blink-features=AutomationControlled']
      : [...serverlessChromium.args, '--disable-blink-features=AutomationControlled', '--renderer-process-limit=1'],
  });
}

async function clickFirstVisible(page, names) {
  for (const name of names) {
    const button = page.getByRole('button', { name, exact: false }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(500);
      return true;
    }
  }
  return false;
}

async function loadEventPage(page, target, diagnostics = null) {
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);

  const acceptedCookies = await clickFirstVisible(page, [
    /Nur erforderliche Cookies erlauben/i,
    /Allow only essential cookies/i,
    /Alle Cookies erlauben/i,
    /Allow all cookies/i,
  ]);

  // The logged-out cookie flow redirects to the profile root. Once the
  // consent cookie exists, revisit the requested list so Facebook renders
  // the public /events/<id> links.
  if (acceptedCookies) {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
  }

  await page.keyboard.press('Escape').catch(() => {});
  await clickFirstVisible(page, [
    /^Schlie(?:ß|ss)en$/i,
    /^Close$/i,
    /^Abbrechen$/i,
    /^Cancel$/i,
    /^Nicht jetzt$/i,
    /^Jetzt nicht$/i,
    /^Not now$/i,
  ]);
  for (const selector of [
    '[role="dialog"] [aria-label="Schließen"]',
    '[role="dialog"] [aria-label="Close"]',
    '[aria-label="Schließen"]',
    '[aria-label="Close"]',
  ]) {
    const closeButton = page.locator(selector).first();
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(500);
      break;
    }
  }

  await page.waitForTimeout(2500);
  let previousHeight = 0;
  let unchangedHeightCount = 0;
  for (let index = 0; index < 12; index += 1) {
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 800)));
    await page.waitForTimeout(800);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    if (height === previousHeight) unchangedHeightCount += 1;
    else unchangedHeightCount = 0;
    previousHeight = height;
    if (unchangedHeightCount >= 2) break;
  }

  if (diagnostics) {
    diagnostics.push(await page.evaluate((requestedUrl) => ({
      requested_url: requestedUrl,
      final_url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2500),
      event_links: Array.from(document.querySelectorAll('a'))
        .map((link) => ({
          href: link.getAttribute('href') || link.href || '',
          text: (link.textContent || link.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200),
        }))
        .filter((link) => /event|veranstaltung/i.test(`${link.href} ${link.text}`))
        .slice(0, 100),
    }), target));
  }

  return page.evaluate(() => {
    const found = new Map();

    function addEvent(id, title = '', contextText = '') {
      if (!/^\d{8,}$/.test(id)) return;
      const cleanTitle = title.replace(/\s+/g, ' ').trim();
      const cleanContext = contextText.replace(/\s+/g, ' ').trim();
      const dateMatch = cleanContext.match(/(?:Mo|Di|Mi|Do|Fr|Sa|So),?\s*\d{1,2}\.\s*(?:Jan\.?|Feb\.?|M(?:ä|ae)rz|Apr\.?|Mai|Juni?|Juli?|Aug\.?|Sept?\.?|Okt\.?|Nov\.?|Dez\.?)[^|]{0,40}/i);
      const hasOwnTitle = cleanTitle.length >= 3
        && cleanTitle.length <= 180
        && !/^(?:event|veranstaltung|mehr|details|facebook)$/i.test(cleanTitle);
      const titleScore = hasOwnTitle ? 2 : (cleanContext ? 1 : 0);
      const event = {
        id,
        title: hasOwnTitle ? cleanTitle : cleanContext.slice(0, 300),
        date_text: dateMatch ? dateMatch[0].trim() : '',
        url: `https://www.facebook.com/events/${id}/`,
        _titleScore: titleScore,
      };
      const previous = found.get(id);
      if (!previous || event._titleScore > previous._titleScore) {
        if (!event.date_text && previous?.date_text) event.date_text = previous.date_text;
        found.set(id, event);
      } else if (!previous.date_text && event.date_text) {
        previous.date_text = event.date_text;
      }
    }

    for (const link of document.querySelectorAll('a')) {
      const rawHref = link.getAttribute('href') || link.href || '';
      let href = rawHref;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const decoded = decodeURIComponent(href);
          if (decoded === href) break;
          href = decoded;
        } catch {
          break;
        }
      }
      try {
        const parsed = new URL(href, location.href);
        const redirected = parsed.searchParams.get('u') || parsed.searchParams.get('href');
        if (redirected) href = decodeURIComponent(redirected);
      } catch {}

      const match = href.match(/(?:facebook\.com)?\/events\/(\d+)/i)
        || href.match(/events(?:%2f|\\\/)+(\d+)/i);
      if (!match) continue;

      const id = match[1];
      const linkTitle = (link.textContent || link.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ')
        .trim();
      let contextText = '';
      let node = link;
      for (let depth = 0; depth < 6 && node?.parentElement; depth += 1) {
        node = node.parentElement;
        const candidate = (node.innerText || '').replace(/\s+/g, ' ').trim();
        if (candidate.length > contextText.length && candidate.length <= 700) contextText = candidate;
      }

      addEvent(id, linkTitle, contextText);
    }

    // Facebook sometimes keeps event links only in its page data instead of
    // rendering them as anchors. Normalize the common encodings and collect
    // those IDs as well so the result does not depend on one DOM layout.
    const pageData = document.documentElement.innerHTML
      .replace(/\\u002F/gi, '/')
      .replace(/\\\//g, '/')
      .replace(/%2F/gi, '/');
    for (const match of pageData.matchAll(/\/events\/(\d{8,})/gi)) {
      addEvent(match[1]);
    }

    return [...found.values()]
      .map(({ _titleScore, ...event }) => event)
      .sort((left, right) => left.id.localeCompare(right.id));
  });
}

async function scrapeEvents(slug, diagnostics = null) {
  const browser = await browserInstance();
  const desktop = process.env.GITHUB_ACTIONS === 'true';
  const context = await browser.newContext({
    locale: 'de-DE',
    serviceWorkers: 'block',
    timezoneId: 'Europe/Berlin',
    viewport: desktop ? { width: 1440, height: 1200 } : { width: 412, height: 915 },
    deviceScaleFactor: 1,
    hasTouch: !desktop,
    isMobile: !desktop,
    userAgent: desktop
      ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
      : 'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  });

  try {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      return ['font', 'image', 'media'].includes(type)
        ? route.abort()
        : route.continue();
    });
    await page.goto('https://www.facebook.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(1200);
    await clickFirstVisible(page, [
      /Nur erforderliche Cookies erlauben/i,
      /Allow only essential cookies/i,
      /Alle Cookies erlauben/i,
      /Allow all cookies/i,
    ]);
    const target = `https://www.facebook.com/${encodeURIComponent(slug)}/upcoming_hosted_events`;
    const events = await loadEventPage(page, target, diagnostics);
    return events.map((event) => ({ ...event, status: 'upcoming' }));
  } finally {
    await context.close();
    await browser.close();
  }
}

async function resultPayload(slug, diagnostics = null) {
  const events = await scrapeEvents(slug, diagnostics);
  return {
    page: slug,
    scope: 'upcoming',
    source: 'facebook-public-browser',
    fetched_at: new Date().toISOString(),
    count: events.length,
    events,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

if (isOneShot) {
  try {
    const diagnostics = process.env.FACEBOOK_SCRAPER_DEBUG === '1' ? [] : null;
    process.stdout.write(`${JSON.stringify(await resultPayload(configuredSlug, diagnostics), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, { ok: true });
      return;
    }

    if (request.method !== 'GET' || url.pathname !== '/events') {
      json(response, 404, { error: 'Not found' });
      return;
    }

    const slug = (url.searchParams.get('slug') || configuredSlug).trim();
    if (slug !== configuredSlug || !/^[a-z0-9._-]+$/i.test(slug)) {
      json(response, 400, { error: 'Facebook page is not allowed' });
      return;
    }

    try {
      const diagnostics = url.searchParams.get('debug') === '1' ? [] : null;
      json(response, 200, await resultPayload(slug, diagnostics));
    } catch (error) {
      json(response, 502, {
        error: error instanceof Error ? error.message : 'Facebook could not be loaded',
      });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`Facebook event browser listening on ${port}\n`);
  });

  async function shutdown() {
    server.close();
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
