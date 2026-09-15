import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('ESPN requests identify the client and cache only successful responses', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /site\.api\.espn\.com/);
    assert.equal(new URL(url).searchParams.get('_tracker'), '2');
    assert.equal(options.headers['user-agent'], 'curl/8.7.1');
    assert.equal(options.headers.accept, 'application/json');
    assert.equal(options.cf.cacheTtlByStatus['300-599'], -1);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ sports: [{ leagues: [{ teams: [{ team: { id: '1', displayName: 'Atlanta Falcons' } }] }] }] });
  });
  const response = await worker.fetch(new Request('https://nfl.ratnani.org/api/teams'), {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).teams[0].name, 'Atlanta Falcons');
});

test('upstream rejection remains an explicit API failure', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Forbidden', { status: 403 }));
  const response = await worker.fetch(new Request('https://nfl.ratnani.org/api/games'), {});
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'upstream 403' });
});

test('a failed teams feed does not block games or navigation', async () => {
  const source = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const elements = new Map();
  const events = new Map();
  const requests = [];
  const context = {
    AbortController, setTimeout, clearTimeout,
    location: { hash: '#/' },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', addEventListener() {} });
        return elements.get(id);
      },
      querySelectorAll: () => [],
    },
    window: { addEventListener: (name, fn) => events.set(name, fn) },
    fetch: async url => {
      requests.push(url);
      if (url === '/api/config') return Response.json({ name: 'NFL Tracker', shortName: 'NFL' });
      if (url === '/api/teams') return new Response('Failed', { status: 502 });
      if (url === '/api/games') return Response.json({ games: [], season: { year: 2026 } });
      throw new Error(`Unexpected request ${url}`);
    },
  };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(elements.get('view').innerHTML, /No games found/);
  assert.match(elements.get('status-chip').innerHTML, /2026 season/);
  assert.equal(requests.filter(url => url === '/api/games').length, 1);
  context.location.hash = '#/teams';
  events.get('hashchange')();
  assert.match(elements.get('view').innerHTML, /Team data is temporarily unavailable/);
});
