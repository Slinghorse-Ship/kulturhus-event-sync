import { readFile, writeFile } from 'node:fs/promises';

const resultFile = 'facebook-events.json';

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function eventId(value) {
  const id = String(value || '').replace(/\D+/g, '');
  return /^\d{8,}$/.test(id) ? id : '';
}

function usefulTitle(value) {
  const title = text(value);
  return title.length >= 3
    && title.length <= 180
    && !/^(?:event|veranstaltung|mehr|details|facebook)$/i.test(title)
    ? title
    : '';
}

function normalizePayload(input, source) {
  const events = new Map();

  for (const item of Array.isArray(input?.events) ? input.events : []) {
    const id = eventId(item?.id || item?.url);
    if (!id) continue;
    events.set(id, {
      id,
      title: usefulTitle(item?.title),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(item?.date || '')) ? String(item.date) : '',
      url: `https://www.facebook.com/events/${id}/`,
      status: 'upcoming',
    });
  }

  for (const diagnostic of Array.isArray(input?.diagnostics) ? input.diagnostics : []) {
    for (const link of Array.isArray(diagnostic?.event_links) ? diagnostic.event_links : []) {
      const match = String(link?.href || '').match(/\/events\/(\d{8,})/i);
      if (!match) continue;
      const id = match[1];
      const title = usefulTitle(link?.text);
      const current = events.get(id) || {
        id,
        title: '',
        date: '',
        url: `https://www.facebook.com/events/${id}/`,
        status: 'upcoming',
      };
      if (title) current.title = title;
      events.set(id, current);
    }
  }

  const cleanEvents = [...events.values()]
    .filter((event) => event.title)
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    page: text(input?.page || process.env.FACEBOOK_PAGE_SLUG || 'kulturhusjaderberg'),
    scope: 'upcoming',
    source,
    fetched_at: text(input?.fetched_at) || new Date().toISOString(),
    count: cleanEvents.length,
    events: cleanEvents,
  };
}

async function primaryResult() {
  if (process.env.PRIMARY_OUTCOME !== 'success') {
    throw new Error(`GitHub-Chromium endete mit Status ${process.env.PRIMARY_OUTCOME || 'unbekannt'}.`);
  }
  const payload = JSON.parse(await readFile(resultFile, 'utf8'));
  const normalized = normalizePayload(payload, 'github-actions-chromium');
  if (!normalized.events.length) throw new Error('GitHub-Chromium fand keine verwendbaren Facebook-Events.');
  return normalized;
}

async function deliver(payload) {
  const callbackUrl = text(process.env.PROCESSWIRE_CALLBACK_URL);
  const callbackToken = text(process.env.PROCESSWIRE_CALLBACK_TOKEN);
  if (!callbackUrl || !callbackToken) {
    process.stdout.write('Kein ProcessWire-Callback übergeben; Ergebnis bleibt als Artifact verfügbar.\n');
    return;
  }

  const response = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Kulturhus-Sync-Token': callbackToken,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  await response.text();
  if (!response.ok) {
    throw new Error(`ProcessWire-Callback antwortete mit HTTP ${response.status}.`);
  }
  process.stdout.write(`ProcessWire hat ${payload.count} Facebook-Events erhalten.\n`);
}

async function main() {
  let payload;
  let primaryError = '';
  try {
    payload = await primaryResult();
  } catch (error) {
    primaryError = error instanceof Error ? error.message : String(error);
    payload = {
      status: 'fallback_required',
      page: text(process.env.FACEBOOK_PAGE_SLUG || 'kulturhusjaderberg'),
      scope: 'upcoming',
      source: 'processwire-fallback-request',
      fetched_at: new Date().toISOString(),
      count: 0,
      events: [],
      delivery: {
        selected_source: 'processwire-graph-api-then-webspace',
        primary_error: primaryError,
      },
    };
    await writeFile(resultFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await deliver(payload);
    process.stdout.write(`GitHub-Chromium war nicht verwendbar; ProcessWire hat den automatischen Rückfall übernommen.\n`);
    return;
  }

  payload.delivery = {
    selected_source: payload.source,
    primary_error: primaryError,
  };
  await writeFile(resultFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await deliver(payload);
  process.stdout.write(`${payload.count} kommende Facebook-Events über ${payload.source} verarbeitet.\n`);
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  await writeFile(resultFile, `${JSON.stringify({
    status: 'failed',
    fetched_at: new Date().toISOString(),
    error: message,
  }, null, 2)}\n`, 'utf8').catch(() => {});
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
