const view = document.getElementById('view');
const statusChip = document.getElementById('status-chip');
let config = null;
let teams = [];
let teamsError = null;
let teamsById = new Map();
let routeToken = 0;

const esc = value => String(value == null ? '' : value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[char]);
const safeUrl = value => /^https?:\/\//i.test(String(value || '')) ? String(value) : '#';
const fmtDate = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); };
const fmtTime = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };

async function fetchJSON(url, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`Server responded ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function skeleton(rows = 7) {
  return `<div class="skeleton-list" aria-hidden="true">${Array.from({ length: rows }, (_, index) => `<span class="sk" style="width:${55 + (index * 9) % 38}%"></span>`).join('')}</div>`;
}

function errorState(message) {
  return `<div class="state"><span class="state-mark">!</span><h2>Could not load</h2><p>${esc(message || 'The data feed is unavailable.')}</p></div>`;
}

function emptyState(title, note) {
  return `<div class="state"><span class="state-mark">-</span><h2>${esc(title)}</h2><p>${esc(note)}</p></div>`;
}

function teamLink(team, className = '') {
  if (!team?.id) return `<span class="${esc(className)}">${esc(team?.name || 'TBD')}</span>`;
  return `<a class="entity-link ${esc(className)}" href="#/team/${encodeURIComponent(team.id)}">${esc(team.name || team.abbr || '')}</a>`;
}

function playerLink(player, className = '') {
  if (!player?.id) return `<span class="${esc(className)}">${esc(player?.name || 'Unknown player')}</span>`;
  return `<a class="entity-link ${esc(className)}" href="#/player/${encodeURIComponent(player.id)}">${esc(player.name || 'Unknown player')}</a>`;
}

function teamLogo(team, size = 30) {
  return team?.logo ? `<img src="${esc(safeUrl(team.logo))}" alt="" width="${size}" height="${size}" loading="lazy">` : '<span class="logo-fallback"></span>';
}

function scoreTeam(team, showScore) {
  return `<div class="score-team">${teamLogo(team, 32)}<div><b>${esc(team.name || 'TBD')}</b>${team.record ? `<small>${esc(team.record)}</small>` : ''}</div>${showScore ? `<strong class="mono${team.winner ? ' winner' : ''}">${esc(team.score ?? '')}</strong>` : ''}</div>`;
}

function gameCard(game) {
  const played = game.state === 'post' || game.state === 'in';
  const status = game.state === 'in' ? `<span class="tag live">${esc(game.clock || game.detail || 'Live')}</span>` : `<span class="tag">${esc(game.state === 'pre' ? fmtTime(game.date) : game.detail || 'Final')}</span>`;
  return `<a class="game-card card" href="#/game/${encodeURIComponent(game.id)}">
    <div class="card-top"><span class="micro">${esc(fmtDate(game.date))}</span>${status}</div>
    <div class="score-teams">${scoreTeam(game.away, played)}${scoreTeam(game.home, played)}</div>
    <div class="game-foot"><span>${esc(game.venue || '')}</span></div>
  </a>`;
}

async function renderGames(token) {
  view.innerHTML = `<div class="view"><div class="wrap"><div class="page-head"><h1>Games</h1><p>Scores and upcoming fixtures from the live league feed.</p></div>${skeleton()}</div></div>`;
  try {
    const data = await fetchJSON('/api/games');
    if (token !== routeToken) return;
    const groups = [
      ['Live now', data.games.filter(game => game.state === 'in')],
      ['Upcoming', data.games.filter(game => game.state === 'pre')],
      ['Final', data.games.filter(game => game.state === 'post')],
    ].filter(([, games]) => games.length);
    const content = groups.length ? groups.map(([title, games]) => `<section class="page-section"><div class="section-head"><h2>${title}</h2><span class="mono">${games.length}</span></div><div class="game-grid">${games.map(gameCard).join('')}</div></section>`).join('') : emptyState('No games found', 'The schedule will populate when the league posts its next fixtures.');
    view.innerHTML = `<div class="view"><div class="wrap"><div class="page-head"><h1>Games</h1><p>${esc(config.shortName)} schedule and results.</p></div>${content}</div></div>`;
    updateStatus(data);
  } catch (error) { if (token === routeToken) view.innerHTML = `<div class="view"><div class="wrap">${errorState(error.message)}</div></div>`; }
}

function standingTable(group) {
  const rows = group.entries.map((entry, index) => `<tr>
    <td class="mono rank">${esc(entry.rank ?? index + 1)}</td>
    <td class="team-cell">${teamLogo(entry.team, 24)}${teamLink(entry.team)}</td>
    <td class="mono">${esc(entry.wins ?? '-')}</td><td class="mono">${esc(entry.losses ?? '-')}</td>
    <td class="mono optional">${esc(entry.ties ?? '-')}</td><td class="mono">${esc(entry.pct ?? '-')}</td>
    <td class="mono optional">${esc(entry.gb ?? '-')}</td><td class="mono optional">${esc(entry.diff ?? '-')}</td>
  </tr>`).join('');
  return `<section class="standings-card card"><h2>${esc(group.name)}</h2><div class="table-scroll"><table><thead><tr><th>#</th><th>Team</th><th>W</th><th>L</th><th class="optional">T</th><th>PCT</th><th class="optional">GB</th><th class="optional">DIFF</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

async function renderStandings(token) {
  view.innerHTML = `<div class="view"><div class="wrap"><div class="page-head"><h1>Standings</h1></div>${skeleton()}</div></div>`;
  try {
    const data = await fetchJSON('/api/standings');
    if (token !== routeToken) return;
    view.innerHTML = `<div class="view"><div class="wrap"><div class="page-head"><h1>Standings</h1><p>Conference position and season record.</p></div><div class="standings-grid">${data.groups.map(standingTable).join('')}</div></div></div>`;
  } catch (error) { if (token === routeToken) view.innerHTML = `<div class="view"><div class="wrap">${errorState(error.message)}</div></div>`; }
}

async function resolveAthletes(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const map = new Map();
  for (let index = 0; index < unique.length; index += 40) {
    const chunk = unique.slice(index, index + 40);
    const data = await fetchJSON('/api/athletes?ids=' + encodeURIComponent(chunk.join(',')));
    for (const [id, player] of Object.entries(data.athletes || {})) if (player) map.set(String(id), player);
  }
  return map;
}

function leaderCard(category, athletes) {
  const max = Math.max(...category.leaders.map(item => Number(item.value) || 0), 1);
  const rows = category.leaders.map((item, index) => {
    const athlete = athletes.get(String(item.athleteId)) || { id: item.athleteId, name: `#${item.athleteId || ''}` };
    const team = teamsById.get(String(item.teamId));
    return `<a class="leader-row" href="#/player/${encodeURIComponent(athlete.id || '')}"><span class="mono muted">${index + 1}</span><div><b>${esc(athlete.name)}</b><small>${esc(team?.abbr || athlete.position || '')}</small><span class="meter"><i style="width:${Math.max(0, Math.min(100, Number(item.value) / max * 100))}%"></i></span></div><strong class="mono">${esc(item.displayValue)}</strong></a>`;
  }).join('');
  return `<section class="leader-card card"><div class="leader-title"><h2>${esc(category.label)}</h2><span class="micro">Top ${category.leaders.length}</span></div>${rows}</section>`;
}

async function renderLeaders(token) {
  view.innerHTML = `<div class="view"><div class="wrap"><div class="page-head"><h1>Leaders</h1></div>${skeleton(10)}</div></div>`;
  try {
    const data = await fetchJSON('/api/leaders');
    const ids = data.categories.flatMap(category => category.leaders.map(item => item.athleteId));
    const athletes = await resolveAthletes(ids);
    if (token !== routeToken) return;
    view.innerHTML = `<div class="view"><div class="wrap"><div class="page-head"><h1>League leaders</h1><p>Top individual performances from the latest complete regular season.</p></div><div class="leader-grid">${data.categories.map(category => leaderCard(category, athletes)).join('')}</div></div></div>`;
  } catch (error) { if (token === routeToken) view.innerHTML = `<div class="view"><div class="wrap">${errorState(error.message)}</div></div>`; }
}

function teamCard(team) {
  return `<a class="team-card card" href="#/team/${encodeURIComponent(team.id)}">${teamLogo(team, 62)}<div><span class="micro">${esc(team.abbr || '')}</span><h2>${esc(team.name)}</h2></div><span class="arrow">›</span></a>`;
}

function renderTeams() {
  if (teamsError) {
    view.innerHTML = `<div class="view"><div class="wrap">${errorState('Team data is temporarily unavailable. Please reload to retry.')}</div></div>`;
    return;
  }
  view.innerHTML = `<div class="view"><div class="wrap"><div class="page-head"><h1>Teams</h1><p>Browse every ${esc(config.shortName)} team, roster, and schedule.</p></div><div class="teams-grid">${teams.map(teamCard).join('')}</div></div></div>`;
}

function detailBack(label, href) { return `<a class="back-link" href="${href}">← ${esc(label)}</a>`; }

function compactGame(game, teamId) {
  const own = String(game.home.id) === String(teamId) ? game.home : game.away;
  const opponent = String(game.home.id) === String(teamId) ? game.away : game.home;
  const played = game.state === 'post' || game.state === 'in';
  return `<a class="schedule-row" href="#/game/${encodeURIComponent(game.id)}"><span><small class="micro">${esc(fmtDate(game.date))}</small><b>${esc(own === game.home ? 'vs' : 'at')} ${esc(opponent.name || 'TBD')}</b></span><span>${teamLogo(opponent, 28)}</span><strong class="mono">${played ? `${esc(own.score ?? '')}-${esc(opponent.score ?? '')}` : esc(fmtTime(game.date))}</strong></a>`;
}

function rosterGroups(roster) {
  const groups = new Map();
  for (const player of roster) {
    const key = player.position || 'Roster';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(player);
  }
  return [...groups.entries()].map(([name, players]) => `<section class="roster-group"><h3>${esc(name)}</h3>${players.map(player => `<a class="roster-row" href="#/player/${encodeURIComponent(player.id)}"><span class="mono muted">${esc(player.jersey || '-')}</span><b>${esc(player.name)}</b><span class="micro muted">${esc(player.positionAbbr || '')}</span></a>`).join('')}</section>`).join('');
}

async function renderTeam(id, token) {
  view.innerHTML = `<div class="view"><div class="wrap">${detailBack('All teams', '#/teams')}${skeleton()}</div></div>`;
  try {
    const data = await fetchJSON('/api/team?id=' + encodeURIComponent(id));
    if (token !== routeToken) return;
    const team = data.team || {};
    document.title = `${team.name || 'Team'} · ${config.name}`;
    view.innerHTML = `<div class="view"><div class="wrap">${detailBack('All teams', '#/teams')}
      <header class="detail-hero"><div class="detail-logo">${teamLogo(team, 130)}</div><div><span class="micro muted">${esc(team.abbr || '')} · ${esc(team.record || 'Season')}</span><h1>${esc(team.name)}</h1><p>${esc(team.venue || '')}</p></div></header>
      <div class="detail-grid"><main><section class="detail-section"><div class="section-head"><h2>Schedule</h2><span class="mono">${data.games.length}</span></div><div class="schedule-list">${data.games.length ? data.games.map(game => compactGame(game, team.id)).join('') : emptyState('No games', 'No schedule is posted.')}</div></section></main>
      <aside><section class="detail-section"><div class="section-head"><h2>Roster</h2><span class="mono">${data.roster.length}</span></div>${data.roster.length ? rosterGroups(data.roster) : emptyState('No roster', 'Roster data is unavailable.')}</section></aside></div>
    </div></div>`;
  } catch (error) { if (token === routeToken) view.innerHTML = `<div class="view"><div class="wrap">${errorState(error.message)}</div></div>`; }
}

function statRows(stats) {
  const rows = Object.entries(stats || {}).filter(([, stat]) => stat.value != null && Number(stat.value) !== 0).slice(0, 32);
  return rows.length ? `<div class="stat-grid">${rows.map(([key, stat]) => `<div class="stat-row"><span>${esc(stat.label || key)}</span><b class="mono">${esc(stat.displayValue ?? stat.value)}</b></div>`).join('')}</div>` : emptyState('No stats', 'No season statistics are available.');
}

async function renderPlayer(id, token) {
  view.innerHTML = `<div class="view"><div class="wrap">${detailBack('Back', '#/leaders')}${skeleton()}</div></div>`;
  try {
    const data = await fetchJSON('/api/player?id=' + encodeURIComponent(id));
    if (token !== routeToken) return;
    const player = data.player || {};
    const team = teamsById.get(String(player.teamId));
    document.title = `${player.name || 'Player'} · ${config.name}`;
    const image = player.headshot ? `<img class="player-photo" src="${esc(safeUrl(player.headshot))}" alt="${esc(player.name)}">` : `<span class="player-initials mono">${esc(String(player.name || '?').split(/\s+/).slice(0, 2).map(part => part[0]).join(''))}</span>`;
    view.innerHTML = `<div class="view"><div class="wrap">${detailBack('Back', '#/leaders')}
      <header class="player-hero"><div class="player-photo-wrap">${image}</div><div><span class="micro muted">${esc([player.position, player.jersey ? `#${player.jersey}` : ''].filter(Boolean).join(' · '))}</span><h1>${esc(player.name)}</h1>${team ? `<div class="player-team">${teamLogo(team, 28)}${teamLink(team)}</div>` : ''}</div></header>
      <div class="detail-grid"><main><section class="detail-section"><div class="section-head"><h2>Season statistics</h2></div>${statRows(data.stats)}</section></main><aside><section class="detail-section"><div class="section-head"><h2>Player info</h2></div><dl class="bio"><div><dt>Full name</dt><dd>${esc(player.fullName || player.name)}</dd></div><div><dt>Age</dt><dd>${esc(player.age ?? '-')}</dd></div><div><dt>Height</dt><dd>${esc(player.height || '-')}</dd></div><div><dt>Weight</dt><dd>${esc(player.weight || '-')}</dd></div></dl></section></aside></div>
    </div></div>`;
  } catch (error) { if (token === routeToken) view.innerHTML = `<div class="view"><div class="wrap">${errorState(error.message)}</div></div>`; }
}

function gameStats(data) {
  const home = data.game.home;
  const away = data.game.away;
  const homeStats = new Map((data.teamStats.find(item => String(item.teamId) === String(home.id))?.stats || []).map(stat => [stat.key, stat]));
  const awayStats = data.teamStats.find(item => String(item.teamId) === String(away.id))?.stats || [];
  return awayStats.slice(0, 20).map(stat => `<div class="compare-row"><span class="mono">${esc(stat.value ?? '-')}</span><b>${esc(stat.label)}</b><span class="mono">${esc(homeStats.get(stat.key)?.value ?? '-')}</span></div>`).join('');
}

function gameLeaders(data) {
  return (data.leaders || []).map(group => {
    const team = teamsById.get(String(group.teamId));
    const rows = group.categories.flatMap(category => (category.leaders || []).slice(0, 1).map(leader => `<div class="game-leader-row"><span><small class="micro muted">${esc(category.label)}</small>${playerLink({ id: leader.athleteId, name: leader.name })}</span><strong class="mono">${esc(leader.value ?? '-')}</strong></div>`)).join('');
    return rows ? `<section class="game-leader-group"><div class="game-leader-team">${teamLogo(team, 28)}<h3>${esc(team?.name || 'Team leaders')}</h3></div>${rows}</section>` : '';
  }).join('');
}

async function renderGame(id, token) {
  view.innerHTML = `<div class="view"><div class="wrap">${detailBack('All games', '#/')}${skeleton()}</div></div>`;
  try {
    const data = await fetchJSON('/api/game?id=' + encodeURIComponent(id));
    if (token !== routeToken) return;
    const game = data.game || {};
    const played = game.state === 'post' || game.state === 'in';
    const leaders = gameLeaders(data);
    view.innerHTML = `<div class="view"><div class="wrap">${detailBack('All games', '#/')}
      <header class="match-hero"><span class="tag${game.state === 'in' ? ' live' : ''}">${esc(game.detail || game.status || '')}</span><div class="match-score"><div>${teamLogo(game.away, 70)}${teamLink(game.away, 'match-team')}</div><strong class="mono">${played ? `${esc(game.away.score ?? '')} - ${esc(game.home.score ?? '')}` : 'vs'}</strong><div>${teamLogo(game.home, 70)}${teamLink(game.home, 'match-team')}</div></div><p>${esc(fmtDate(game.date))} · ${esc(fmtTime(game.date))} · ${esc(game.venue || '')}</p></header>
      <section class="detail-section"><div class="section-head"><h2>Team statistics</h2></div><div class="compare-head"><span>${esc(game.away.abbr)}</span><span>${esc(game.home.abbr)}</span></div><div class="compare-list">${gameStats(data) || emptyState('No stats', 'Game statistics are not posted yet.')}</div></section>
      ${leaders ? `<section class="detail-section"><div class="section-head"><h2>Game leaders</h2></div><div class="game-leaders">${leaders}</div></section>` : ''}
    </div></div>`;
  } catch (error) { if (token === routeToken) view.innerHTML = `<div class="view"><div class="wrap">${errorState(error.message)}</div></div>`; }
}

function updateStatus(data) {
  const text = data?.anyLive ? 'Live now' : data?.season?.year ? `${data.season.year} season` : 'League tracker';
  statusChip.innerHTML = `<span class="${data?.anyLive ? 'live-dot' : 'idle-dot'}"></span><span class="mono">${esc(text)}</span>`;
}

function setNav(active) {
  document.querySelectorAll('[data-nav]').forEach(link => link.toggleAttribute('aria-current', link.dataset.nav === active));
}

function router() {
  const token = ++routeToken;
  const hash = location.hash || '#/';
  if (/^#\/team\//.test(hash)) { setNav('teams'); return renderTeam(decodeURIComponent(hash.replace('#/team/', '')), token); }
  if (/^#\/player\//.test(hash)) { setNav('leaders'); return renderPlayer(decodeURIComponent(hash.replace('#/player/', '')), token); }
  if (/^#\/game\//.test(hash)) { setNav('games'); return renderGame(decodeURIComponent(hash.replace('#/game/', '')), token); }
  if (hash === '#/standings') { setNav('standings'); return renderStandings(token); }
  if (hash === '#/leaders') { setNav('leaders'); return renderLeaders(token); }
  if (hash === '#/teams') { setNav('teams'); return renderTeams(); }
  setNav('games'); return renderGames(token);
}

function setupTheme() {
  const button = document.getElementById('theme-toggle');
  button.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.toggleAttribute('data-theme', next === 'light');
    try { localStorage.setItem('sports-theme', next); } catch (_) {}
  });
}

async function bootstrap() {
  setupTheme();
  try {
    const [configData, teamData] = await Promise.all([fetchJSON('/api/config'), fetchJSON('/api/teams').catch(error => { teamsError = error; return { teams: [] }; })]);
    config = configData;
    teams = teamData.teams || [];
    teamsById = new Map(teams.map(team => [String(team.id), team]));
    document.getElementById('brand-main').textContent = config.shortName;
    document.getElementById('footer-title').textContent = config.name;
    document.title = config.name;
    window.addEventListener('hashchange', router);
    updateStatus(null);
    router();
  } catch (error) { view.innerHTML = `<div class="view"><div class="wrap">${errorState(error.message)}</div></div>`; }
}

bootstrap();
