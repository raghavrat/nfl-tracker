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

test('play-by-play merges current and previous drives without duplicates, newest first', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    drives: {
      previous: [{ team: { id: '7' }, plays: [
        { id: 'a', sequenceNumber: '100', text: 'First play', period: { number: 4 } },
        { id: 'b', sequenceNumber: '200', text: 'Old text' },
      ] }],
      current: { team: { id: '12' }, plays: [
        { id: 'b', sequenceNumber: '200', text: 'Touchdown', scoringPlay: true, homeScore: 0, awayScore: 6, period: { number: 5 }, clock: { displayValue: '8:00' }, start: { team: { id: '7' }, downDistanceText: '1st & Goal' } },
        { id: 'c', sequenceNumber: '300', text: 'Interception', isTurnover: true },
      ] },
    },
  }));
  const response = await worker.fetch(new Request('https://nfl.ratnani.org/api/game?id=123'), {});
  const { plays } = await response.json();
  assert.deepEqual(plays.map(p => p.id), ['c', 'b', 'a']);
  assert.equal(plays[0].turnover, true);
  assert.equal(plays[1].text, 'Touchdown');
  assert.equal(plays[1].homeScore, 0);
  assert.equal(plays[1].teamId, '7');
  assert.equal(plays[1].period, 5);
});

test('games without drive data return an empty play list', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({}));
  const response = await worker.fetch(new Request('https://nfl.ratnani.org/api/game?id=123'), {});
  assert.deepEqual((await response.json()).plays, []);
});

test('play rendering handles overtime, zero scores, missing data, and escapes feed text', async () => {
  const source = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const context = vm.createContext({ document: { getElementById: () => ({}) } });
  vm.runInContext(source.replace(/bootstrap\(\);\s*$/, ''), context);
  context.data = { game: { state: 'post', away: { id: '7', abbr: 'DEN' }, home: { id: '12', abbr: 'KC' } }, plays: [{ period: 5, clock: '8:00', text: '<script>bad</script>', teamId: '7', scoringPlay: true, awayScore: 6, homeScore: 0 }] };
  const html = vm.runInContext('playByPlay(data)', context);
  assert.match(html, />OT</);
  assert.match(html, /DEN 6 · KC 0/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  context.data = { game: { state: 'pre' } };
  assert.match(vm.runInContext('playByPlay(data)', context), /after kickoff/);
});
