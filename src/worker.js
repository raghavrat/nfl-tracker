const CONFIG = {
  sport: 'football',
  league: 'nfl',
  name: 'NFL Tracker',
  shortName: 'NFL',
  season: 2025,
  scheduleSeason: 2026,
  seasonType: 2,
  leaderKeys: ['passingYards', 'rushingYards', 'receivingYards', 'passingTouchdowns', 'rushingTouchdowns', 'receivingTouchdowns', 'totalTackles', 'sacks', 'interceptions'],
  playerStatKeys: [
    'gamesPlayed', 'gamesStarted', 'completions', 'passingAttempts', 'completionPct',
    'passingYards', 'passingYardsPerGame', 'passingTouchdowns', 'interceptions', 'quarterbackRating',
    'rushingAttempts', 'rushingYards', 'rushingYardsPerGame', 'rushingTouchdowns',
    'receivingTargets', 'receptions', 'receivingYards', 'receivingYardsPerGame', 'receivingTouchdowns',
    'totalTackles', 'soloTackles', 'assistTackles', 'sacks', 'tacklesForLoss',
  ],
};

const SITE = `https://site.api.espn.com/apis/site/v2/sports/${CONFIG.sport}/${CONFIG.league}`;
const SITE_V2 = `https://site.api.espn.com/apis/v2/sports/${CONFIG.sport}/${CONFIG.league}`;
const CORE = `https://sports.core.api.espn.com/v2/sports/${CONFIG.sport}/leagues/${CONFIG.league}`;

const json = (value, ttl = 60, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${ttl}`, 'access-control-allow-origin': '*' },
});

async function fetchJSON(url, ttl = 60) {
  const response = await fetch(url, { cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!response.ok) {
    const error = new Error(`upstream ${response.status}`);
    error.upstreamStatus = response.status;
    throw error;
  }
  return response.json();
}

const idFromRef = ref => String(ref || '').match(/\/(\d+)(?=\?|$)/)?.[1] || null;
const teamLogo = team => team?.logos?.find(logo => (logo.rel || []).includes('default'))?.href || team?.logos?.[0]?.href || team?.logo || null;
const scoreValue = competitor => typeof competitor?.score === 'object' ? competitor.score.displayValue ?? competitor.score.value ?? null : competitor?.score ?? null;

function side(competition, homeAway) {
  const competitor = (competition.competitors || []).find(item => item.homeAway === homeAway) || {};
  const team = competitor.team || {};
  return { id: team.id ?? competitor.id ?? null, name: team.displayName ?? team.name ?? null, abbr: team.abbreviation ?? null, logo: teamLogo(team), score: scoreValue(competitor), winner: competitor.winner ?? null, record: competitor.records?.[0]?.summary ?? null };
}

function normalizeEvent(event) {
  const competition = event.competitions?.[0] || {};
  return {
    id: event.id ?? competition.id ?? null,
    date: competition.date ?? event.date ?? null,
    name: event.name ?? null,
    state: competition.status?.type?.state ?? event.status?.type?.state ?? null,
    status: competition.status?.type?.description ?? event.status?.type?.description ?? null,
    detail: competition.status?.type?.shortDetail ?? competition.status?.type?.detail ?? event.status?.type?.shortDetail ?? null,
    period: competition.status?.period ?? null,
    clock: competition.status?.displayClock ?? null,
    venue: competition.venue?.fullName ?? null,
    home: side(competition, 'home'),
    away: side(competition, 'away'),
  };
}

async function apiGames() {
  const data = await fetchJSON(`${SITE}/scoreboard?limit=100`, 30);
  const games = (data.events || []).map(normalizeEvent).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return json({ updatedAt: new Date().toISOString(), season: data.season ?? null, anyLive: games.some(game => game.state === 'in'), games }, games.some(game => game.state === 'in') ? 15 : 60);
}

async function apiStandings() {
  const data = await fetchJSON(`${SITE_V2}/standings?season=${CONFIG.season}`, 300);
  const groups = (data.children || []).map(group => ({
    name: group.name ?? null,
    entries: (group.standings?.entries || []).map(entry => {
      const stats = Object.fromEntries((entry.stats || []).map(stat => [stat.name, stat]));
      const team = entry.team || {};
      const val = key => stats[key]?.value ?? null;
      const shown = key => stats[key]?.displayValue ?? val(key);
      return {
        team: { id: team.id ?? null, name: team.displayName ?? null, abbr: team.abbreviation ?? null, logo: teamLogo(team) },
        rank: val('playoffSeed') ?? val('rank'), wins: val('wins'), losses: val('losses'), ties: val('ties'),
        pct: shown('winPercent') ?? shown('leagueWinPercent'), gb: shown('gamesBehind'),
        for: shown('pointsFor') ?? shown('avgPointsFor'), against: shown('pointsAgainst') ?? shown('avgPointsAgainst'),
        diff: shown('pointDifferential') ?? shown('differential'),
      };
    }).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)),
  }));
  return json({ updatedAt: new Date().toISOString(), groups }, 300);
}

async function teamsData() {
  const data = await fetchJSON(`${SITE}/teams?limit=100`, 86400);
  return (data.sports?.[0]?.leagues?.[0]?.teams || []).map(item => item.team || item).map(team => ({
    id: team.id ?? null, name: team.displayName ?? team.name ?? null, shortName: team.shortDisplayName ?? null,
    abbr: team.abbreviation ?? null, logo: teamLogo(team), color: team.color ?? null,
  }));
}

async function apiTeams() {
  return json({ updatedAt: new Date().toISOString(), teams: await teamsData() }, 86400);
}

async function apiLeaders() {
  const data = await fetchJSON(`${CORE}/seasons/${CONFIG.season}/types/${CONFIG.seasonType}/leaders?limit=10`, 600);
  const wanted = new Set(CONFIG.leaderKeys);
  const categories = (data.categories || []).filter(category => wanted.has(category.name)).map(category => ({
    key: category.name, label: category.displayName ?? category.name,
    leaders: (category.leaders || []).filter(leader => leader.value != null).slice(0, 10).map(leader => ({
      athleteId: idFromRef(leader.athlete?.$ref), teamId: idFromRef(leader.team?.$ref), value: leader.value, displayValue: leader.displayValue ?? String(leader.value),
    })),
  }));
  return json({ updatedAt: new Date().toISOString(), categories }, 600);
}

async function apiAthletes(idsParam) {
  const ids = String(idsParam || '').split(',').map(value => value.trim()).filter(Boolean).slice(0, 40);
  if (!ids.length) return json({ error: 'missing ids' }, 10, 400);
  const entries = await Promise.all(ids.map(async id => {
    try {
      const athlete = await fetchJSON(`${CORE}/seasons/${CONFIG.season}/athletes/${id}`, 86400);
      return [id, { id: athlete.id ?? id, name: athlete.displayName ?? athlete.fullName ?? null, shortName: athlete.shortName ?? null, position: athlete.position?.abbreviation ?? null, jersey: athlete.jersey ?? null, headshot: athlete.headshot?.href ?? null, teamId: idFromRef(athlete.team?.$ref) }];
    } catch { return [id, null]; }
  }));
  return json({ athletes: Object.fromEntries(entries) }, 86400);
}

function normalizeRoster(data) {
  const athletes = (data.athletes || []).flatMap(group => Array.isArray(group.items) ? group.items : [group]);
  return athletes.map(athlete => ({ id: athlete.id ?? null, name: athlete.displayName ?? athlete.fullName ?? null, jersey: athlete.jersey ?? null, position: athlete.position?.displayName ?? null, positionAbbr: athlete.position?.abbreviation ?? null, headshot: athlete.headshot?.href ?? null })).filter(player => player.id && player.name);
}

async function apiTeam(id) {
  if (!/^\d+$/.test(String(id || ''))) return json({ error: 'invalid id' }, 10, 400);
  const [teamData, rosterData, scheduleData] = await Promise.all([
    fetchJSON(`${SITE}/teams/${id}`, 86400),
    fetchJSON(`${SITE}/teams/${id}/roster`, 86400).catch(() => ({})),
    fetchJSON(`${SITE}/teams/${id}/schedule?season=${CONFIG.scheduleSeason}`, 300).catch(() => ({})),
  ]);
  const team = teamData.team || teamData;
  const games = (scheduleData.events || []).map(normalizeEvent).filter(game => game.home.id === String(id) || game.away.id === String(id) || game.home.id === id || game.away.id === id);
  return json({
    team: { id: team.id ?? id, name: team.displayName ?? team.name ?? null, shortName: team.shortDisplayName ?? null, abbr: team.abbreviation ?? null, logo: teamLogo(team), color: team.color ?? null, venue: team.venue?.fullName ?? null, record: team.record?.items?.[0]?.summary ?? null },
    roster: normalizeRoster(rosterData), games,
  }, 300);
}

function statMap(data) {
  const result = {};
  for (const category of data.splits?.categories || []) for (const stat of category.stats || []) result[stat.name] = { label: stat.displayName ?? stat.name, value: stat.value ?? null, displayValue: stat.displayValue ?? null };
  return result;
}

async function apiPlayer(id) {
  if (!/^\d+$/.test(String(id || ''))) return json({ error: 'invalid id' }, 10, 400);
  const [athlete, statistics] = await Promise.all([
    fetchJSON(`${CORE}/seasons/${CONFIG.season}/athletes/${id}`, 86400),
    fetchJSON(`${CORE}/seasons/${CONFIG.season}/types/${CONFIG.seasonType}/athletes/${id}/statistics`, 600).catch(() => ({})),
  ]);
  return json({
    player: { id: athlete.id ?? id, name: athlete.displayName ?? athlete.fullName ?? null, fullName: athlete.fullName ?? athlete.displayName ?? null, headshot: athlete.headshot?.href ?? null, jersey: athlete.jersey ?? null, position: athlete.position?.displayName ?? null, age: athlete.age ?? null, dateOfBirth: athlete.dateOfBirth ?? null, height: athlete.displayHeight ?? null, weight: athlete.displayWeight ?? null, teamId: idFromRef(athlete.team?.$ref) },
    stats: Object.fromEntries(Object.entries(statMap(statistics)).filter(([key]) => CONFIG.playerStatKeys.includes(key))),
  }, 600);
}

async function apiGame(id) {
  if (!/^\d+$/.test(String(id || ''))) return json({ error: 'invalid id' }, 10, 400);
  const data = await fetchJSON(`${SITE}/summary?event=${id}`, 30);
  const competition = data.header?.competitions?.[0] || {};
  const event = normalizeEvent({ id, date: competition.date, competitions: [competition] });
  const teamStats = (data.boxscore?.teams || []).map(item => ({ teamId: item.team?.id ?? null, stats: (item.statistics || []).map(stat => ({ key: stat.name, label: stat.label ?? stat.displayName ?? stat.name, value: stat.displayValue ?? stat.value ?? null })) }));
  const leaders = (data.leaders || []).map(group => ({ teamId: group.team?.id ?? null, categories: (group.leaders || []).map(category => ({ label: category.displayName ?? category.name, leaders: (category.leaders || []).slice(0, 3).map(leader => ({ athleteId: leader.athlete?.id ?? null, name: leader.athlete?.displayName ?? null, value: leader.displayValue ?? leader.value ?? null })) })) }));
  return json({ game: event, teamStats, leaders }, event.state === 'in' ? 15 : 300);
}

const routes = {
  '/api/config': () => json(CONFIG, 86400), '/api/games': () => apiGames(), '/api/standings': () => apiStandings(),
  '/api/teams': () => apiTeams(), '/api/leaders': () => apiLeaders(), '/api/athletes': params => apiAthletes(params.get('ids')),
  '/api/team': params => apiTeam(params.get('id')), '/api/player': params => apiPlayer(params.get('id')), '/api/game': params => apiGame(params.get('id')),
};

async function handle(fn) {
  try { return await fn(); } catch (error) { return json({ error: error.upstreamStatus ? `upstream ${error.upstreamStatus}` : String(error.message || error) }, 10, error.upstreamStatus ? 502 : 500); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const route = routes[url.pathname];
      if (!route) return json({ error: 'not found' }, 10, 404);
      return handle(() => route(url.searchParams));
    }
    return env.ASSETS.fetch(request);
  },
};
