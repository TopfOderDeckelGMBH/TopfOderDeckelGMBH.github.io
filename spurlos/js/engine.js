"use strict";
/* ===== Spiel-Engine: läuft nur auf dem Gerät, das die Gruppe gerade hostet ===== */
const H = {group:null, game:null, pos:{}, conns:{}, online:new Set(), timer:null, lastSave:0};
const CATCH_R = 30, TAG_R = 25, FLAG_R = 20, BOT_CATCH_R = 12;
const CLASSIC_LIKE = ['classic', 'fugitive', 'questions'];

function myMember(){ return {id:ME.id, name:PROFILE.name || 'Spieler', avatar:PROFILE.avatar || null}; }
const displayName = m => (m && (m.nick || m.name)) || 'Spieler';
const isActive = p => !p.caught && !p.jail;
const sideOf = p => p.role === 'hunter' ? 'hunter' : 'hider';

function hostInit(group){
  hostStop();
  H.group = structuredClone(group);
  H.group.settings = sanitizeSettings(H.group.settings, H.group.mode);
  H.group.members = H.group.members || {};
  H.group.chat = H.group.chat || [];
  H.game = null; H.pos = {}; H.conns = {}; H.online = new Set([ME.id]);
  upsertMember(ME.id, myMember());
  H.timer = setInterval(hostTick, 1000);
  deliver(ME.id, {t:'chatHistory', chat:H.group.chat});
  hostBroadcastGroup();
}
function hostStop(){
  clearInterval(H.timer); H.timer = null;
  for (const c of Object.values(H.conns)) try { c.close(); } catch(e){}
  H.conns = {}; H.group = null; H.game = null; H.online = new Set();
}
function hostAccept(c){
  let id = null;
  c.on('data', m => {
    if (!m || typeof m !== 'object' || !H.group) return;
    if (m.t === 'hello'){
      const nid = String((m.member && m.member.id) || '').slice(0, 24);
      if (!nid || nid === ME.id) return;
      if (H.conns[nid] && H.conns[nid] !== c) try { H.conns[nid].close(); } catch(e){}
      id = nid; H.conns[id] = c;
    }
    if (id) hostHandle(id, m);
  });
  c.on('close', () => {
    if (id && H.conns[id] === c){ delete H.conns[id]; H.online.delete(id); hostBroadcastGroup(); }
  });
}
function deliver(id, msg){
  if (id === ME.id) recv(structuredClone(msg));
  else { const c = H.conns[id]; if (c && c.open) try { c.send(msg); } catch(e){} }
}
function deliverAll(msg){ for (const id of H.online) deliver(id, msg); }
function groupPublic(){
  const g = H.group, {chat, ...rest} = g;
  return structuredClone(rest);
}
function hostBroadcastGroup(){
  if (!H.group) return;
  const G = H.game;
  deliverAll({t:'group', group:groupPublic(), online:[...H.online],
    game: G && G.phase === 'running' ? {mode:G.mode, startedAt:G.startedAt, players:Object.keys(G.players)} : null});
}

function upsertMember(id, m){
  const g = H.group, old = g.members[id] || {};
  g.members[id] = {
    id, name: String((m && m.name) || old.name || 'Spieler').trim().slice(0, 20) || 'Spieler',
    avatar: m && typeof m.avatar === 'string' && m.avatar.startsWith('data:image/') && m.avatar.length < 30000 ? m.avatar : (old.avatar || null),
    nick: old.nick || '', pref: old.pref || 'hider', personalZone: old.personalZone || null,
    bot: !!(m && m.bot) || !!old.bot, joinedAt: old.joinedAt || now()
  };
}
function addChat(from, text, img, sys = false){
  const g = H.group; if (!g) return;
  const m = from ? g.members[from] : null;
  const msg = {id:uid(8), from: from || null, name: sys ? '' : displayName(m), text: String(text || '').slice(0, 500),
    img: typeof img === 'string' && img.startsWith('data:image/') && img.length < 450000 ? img : null, t:now(), sys:!!sys};
  if (!msg.text && !msg.img) return;
  g.chat = g.chat.concat(msg).slice(-150);
  deliverAll({t:'chat', msg});
}
function ev(text, icon = '•'){
  const G = H.game; if (!G) return;
  G.events.push({t:now(), text, icon});
  if (G.events.length > 120) G.events.shift();
}

function hostHandle(id, m){
  const g = H.group; if (!g) return;
  const isAdmin = id === g.admin;
  const running = H.game && H.game.phase === 'running';
  switch (m.t){
    case 'hello':
      upsertMember(id, m.member); H.online.add(id);
      deliver(id, {t:'chatHistory', chat:g.chat});
      hostBroadcastGroup();
      if (running) sendViews();
      break;
    case 'pos':
      if (validPos(m)){ H.pos[id] = {lat:+m.lat, lng:+m.lng, t:now()}; trackPos(id); }
      break;
    case 'chat': addChat(id, m.text, m.img); break;
    case 'member': patchMember(id, m.patch || {}); break;
    case 'settings':
      if (!isAdmin) return deliver(id, {t:'toast', msg:'Nur der Admin kann die Einstellungen ändern.'});
      if (running) return deliver(id, {t:'toast', msg:'Während eines Spiels kann man nichts ändern.'});
      {
        const p = m.patch || {}, cur = g.settings, next = Object.assign({}, cur);
        for (const k in p){ if (k === 'zones') next.zones = Object.assign({}, cur.zones, p.zones); else next[k] = p[k]; }
        g.settings = sanitizeSettings(next, g.mode);
      }
      hostBroadcastGroup(); break;
    case 'group':
      if (!isAdmin) return;
      if (typeof m.name === 'string' && m.name.trim().length >= 2) g.name = m.name.trim().slice(0, 30);
      if (typeof m.rules === 'string') g.rules = m.rules.slice(0, 1000);
      if (MODES[m.mode] && !running){ g.mode = m.mode; g.settings = sanitizeSettings(g.settings, g.mode); }
      hostBroadcastGroup(); break;
    case 'start': startGame(id); break;
    case 'end':
      if (running && isAdmin) endGame(null, 'Der Admin hat das Spiel beendet.');
      break;
    default:
      if (running){ gameAction(id, m); }
  }
}
function patchMember(id, p){
  const g = H.group, m = g.members[id]; if (!m) return;
  if (typeof p.nick === 'string') m.nick = p.nick.trim().slice(0, 20);
  if (['hider','hunter','red','blue'].includes(p.pref) && !(H.game && H.game.phase === 'running')) m.pref = p.pref;
  if ('personalZone' in p){
    const z = p.personalZone;
    if (z === null) m.personalZone = null;
    else if (validPos(z)) m.personalZone = {lat:+z.lat, lng:+z.lng, r:clamp(+z.r || 100, 20, g.settings.zones.personalMax)};
  }
  hostBroadcastGroup();
}

/* ---------- Spielstart ---------- */
function startGame(starterId){
  const g = H.group, s = g.settings;
  if (H.game && H.game.phase === 'running') return;
  const ids = [...H.online].filter(id => g.members[id] && (s.adminPlays || id !== g.admin));
  if (ids.length < 2) return deliver(starterId, {t:'toast', msg:'Zum Starten braucht es mindestens 2 aktive Spieler.'});
  const roles = assignRoles(g.mode, s, ids);
  if (typeof roles === 'string') return deliver(starterId, {t:'toast', msg:roles});

  const t = now();
  let center = s.zones.center;
  if (!center){
    const ps = ids.map(i => H.pos[i]).filter(Boolean);
    if (ps.length) center = {lat: ps.reduce((a, p) => a + p.lat, 0) / ps.length, lng: ps.reduce((a, p) => a + p.lng, 0) / ps.length};
  }
  if (g.mode === 'ctf' && !center) return deliver(starterId, {t:'toast', msg:'Für Capture the Flag braucht es ein Spielfeld. Lege eins fest oder schalte den Standort ein.'});
  let zone = null;
  if (s.zones.enabled && center){
    const r0 = s.zones.radius, rF = s.zones.shrinking ? r0 * .4 : r0;
    let target = center;
    if (s.zones.wandering){ const off = Math.random() * Math.max(0, r0 - rF) * .9; target = movePos(center, Math.random() * Math.PI * 2, off); }
    zone = {c0:center, r0, center, radius:r0, target};
  }
  const G = {
    mode:g.mode, phase:'running', startedAt:t, huntStartAt:t + s.headStart * MIN, endAt:t + s.duration * MIN,
    pingInterval:s.pingEvery * MIN, nextPingAt:t + (s.headStart + s.pingEvery) * MIN, ping:null, pingCount:0,
    players:{}, events:[], zone, extraZones:[], score:{red:0, blue:0}, flags:null, questions:[], lastQuestionAt:0,
    lastDist:{}, bounty:[], lastBountyUpdate:0
  };
  if (G.endAt <= G.huntStartAt) G.endAt = G.huntStartAt + 5 * MIN;
  for (const id of ids){
    const m = g.members[id];
    G.players[id] = {id, name:displayName(m), role:roles[id], initialRole:roles[id], caught:false, caughtAt:null, jail:false,
      catches:0, points:0, totalPoints:0, nextPointAt:G.huntStartAt + 10 * MIN, inv:{revive:0, reboot:0},
      immuneUntil:0, cloakUntil:0, bountyUntil:0, zoneOffUntil:0, target:null, track:[], distance:0, bot:!!m.bot, out:false, safe:false};
  }
  if (g.mode === 'assassin'){
    const order = shuffle([...ids]);
    order.forEach((id, i) => { G.players[id].target = order[(i + 1) % order.length]; });
  }
  if (g.mode === 'ctf'){
    const off = (zone ? zone.r0 : 300) * .5;
    G.flags = {red:{home:movePos(center, -Math.PI / 2, off), carrier:null}, blue:{home:movePos(center, Math.PI / 2, off), carrier:null}};
  }
  H.game = G;
  for (const id of ids) trackPos(id);
  ev(`Spiel gestartet (${MODES[g.mode].name})`, '🚩');
  if (s.headStart) ev(`${s.headStart} Min. Vorsprung für die Versteckten`, '⏳');
  g.status = 'running';
  addChat(null, `🚩 Spiel gestartet: ${MODES[g.mode].name}`, null, true);
  hostBroadcastGroup();
  sendViews();
}
function assignRoles(mode, s, ids){
  const m = H.group.members, sh = shuffle([...ids]), out = {};
  if (mode === 'assassin'){ ids.forEach(i => out[i] = 'assassin'); return out; }
  if (mode === 'ctf'){
    let red = [], blue = [];
    if (s.seekerMode === 'choose'){ red = ids.filter(i => m[i].pref === 'red'); blue = ids.filter(i => m[i].pref === 'blue'); }
    for (const i of sh) if (!red.includes(i) && !blue.includes(i)) (red.length <= blue.length ? red : blue).push(i);
    if (!red.length || !blue.length) return 'Beide Teams brauchen mindestens einen Spieler.';
    red.forEach(i => out[i] = 'red'); blue.forEach(i => out[i] = 'blue'); return out;
  }
  if (mode === 'fugitive'){
    let fug = s.seekerMode === 'choose' ? shuffle(ids.filter(i => m[i].pref === 'hider'))[0] : null;
    fug = fug || sh[0];
    ids.forEach(i => out[i] = i === fug ? 'hider' : 'hunter'); return out;
  }
  const n = clamp(s.seekerCount, 1, ids.length - 1);
  let hunters;
  if (s.seekerMode === 'choose'){
    hunters = ids.filter(i => m[i].pref === 'hunter');
    if (!hunters.length) return 'Niemand hat „Sucher“ gewählt.';
    if (hunters.length === ids.length) return 'Mindestens einer muss sich verstecken.';
  } else if (s.seekerMode === 'creator'){
    hunters = ids.includes(H.group.admin) ? [H.group.admin] : [];
    for (const i of sh){ if (hunters.length >= n) break; if (!hunters.includes(i)) hunters.push(i); }
  } else hunters = sh.slice(0, n);
  ids.forEach(i => out[i] = hunters.includes(i) ? 'hunter' : 'hider');
  return out;
}

/* ---------- Laufendes Spiel ---------- */
function trackPos(id){
  const G = H.game; if (!G || G.phase !== 'running') return;
  const p = G.players[id], pos = H.pos[id]; if (!p || !pos) return;
  const last = p.track[p.track.length - 1];
  if (!last){ p.track.push({lat:pos.lat, lng:pos.lng, t:pos.t}); return; }
  const d = dist(last, pos);
  if (d >= 8 && pos.t - last.t >= 3000){
    if (d < 200 || pos.t - last.t > 20000) p.distance += d; // GPS-Sprünge ignorieren
    p.track.push({lat:pos.lat, lng:pos.lng, t:pos.t});
    if (p.track.length > 3000) p.track = p.track.filter((_, i) => i % 2 === 0);
  }
}
function inSafeZone(G, p, pos, t){
  const s = H.group.settings.zones;
  if (CLASSIC_LIKE.includes(G.mode) && p.role !== 'hider') return false;
  if (s.safeZonesAllowed && s.safeZones.some(z => dist(z, pos) <= z.r)) return true;
  if (p.zoneOffUntil > t) return false;
  const m = H.group.members[p.id];
  if (s.personal && m && m.personalZone && dist(m.personalZone, pos) <= m.personalZone.r) return true;
  return G.extraZones.some(z => z.owner === p.id && dist(z, pos) <= z.r);
}
function territory(G, pos){ return dist(pos, G.flags.red.home) < dist(pos, G.flags.blue.home) ? 'red' : 'blue'; }
const teamName = k => k === 'red' ? 'Rot' : 'Blau';

function hostTick(){
  const g = H.group; if (!g) return;
  const t = now(), G = H.game;
  if (!G || G.phase !== 'running'){
    if (g.settings.startAt && t >= g.settings.startAt){ g.settings.startAt = null; startGame(g.admin); }
    botsIdle(t);
    return;
  }
  botsTick(G, t);
  const s = g.settings;
  if (G.zone){
    const prog = clamp((t - G.huntStartAt) / (G.endAt - G.huntStartAt), 0, 1);
    if (s.zones.shrinking) G.zone.radius = G.zone.r0 * (1 - .6 * prog);
    if (s.zones.wandering) G.zone.center = lerpPos(G.zone.c0, G.zone.target, prog);
  }
  const ps = Object.values(G.players);
  for (const p of ps){
    const pos = H.pos[p.id];
    p.out = !!(G.zone && pos && isActive(p) && dist(pos, G.zone.center) > G.zone.radius);
    p.safe = !!(pos && isActive(p) && inSafeZone(G, p, pos, t));
  }
  for (const p of ps){
    if (isActive(p) && sideOf(p) === 'hider' && t >= p.nextPointAt){ p.points++; p.totalPoints++; p.nextPointAt += 10 * MIN; }
  }
  if (G.mode !== 'questions' && t >= G.huntStartAt && t >= G.nextPingAt){
    doPing(G, t);
    if (s.pingFaster) G.pingInterval = Math.max(MIN, G.pingInterval * .8);
    G.nextPingAt = t + G.pingInterval;
  }
  if (t - G.lastBountyUpdate >= MIN){
    G.lastBountyUpdate = t;
    G.bounty = ps.filter(p => p.bountyUntil > t && isActive(p) && H.pos[p.id]).map(p => ({id:p.id, name:p.name, role:p.role, pos:{lat:H.pos[p.id].lat, lng:H.pos[p.id].lng}, at:t}));
  }
  if (G.mode === 'ctf') ctfTick(G, t);
  checkEnd(G, t);
  if (H.game && H.game.phase === 'running') sendViews();
}
function doPing(G, t){
  const who = H.group.settings.pingWho, list = [];
  for (const p of Object.values(G.players)){
    const pos = H.pos[p.id];
    if (!pos || !isActive(p) || p.cloakUntil > t || p.safe) continue;
    let inc = true;
    if (G.mode === 'classic' || G.mode === 'fugitive') inc = who === 'both' || p.role === who;
    if (inc) list.push({id:p.id, name:p.name, role:p.role, pos:{lat:pos.lat, lng:pos.lng}});
  }
  G.ping = {at:t, list}; G.pingCount++;
}
function ctfTick(G, t){
  for (const p of Object.values(G.players)){
    const pos = H.pos[p.id]; if (!pos) continue;
    const own = G.flags[p.role], ek = p.role === 'red' ? 'blue' : 'red', enemy = G.flags[ek];
    if (p.jail){
      if (dist(pos, own.home) <= FLAG_R){ p.jail = false; ev(`${p.name} ist zurück im Spiel`, '↩️'); }
      continue;
    }
    if (!enemy.carrier && dist(pos, enemy.home) <= FLAG_R){ enemy.carrier = p.id; ev(`${p.name} hat die Flagge von Team ${teamName(ek)} geklaut!`, '🚩'); }
    if (enemy.carrier === p.id && dist(pos, own.home) <= FLAG_R){
      G.score[p.role]++; enemy.carrier = null; p.points += 3; p.totalPoints += 3;
      ev(`Punkt für Team ${teamName(p.role)}! (${G.score.red}:${G.score.blue})`, '🏆');
    }
  }
}
function checkEnd(G, t){
  if (!G || G.phase !== 'running') return;
  const ps = Object.values(G.players), s = H.group.settings;
  if (G.mode === 'assassin'){
    const alive = ps.filter(isActive);
    if (alive.length <= 1) return endGame(alive[0] ? {player:alive[0].id} : null, 'Niemand ist übrig.');
    if (t >= G.endAt){ alive.sort((a, b) => b.catches - a.catches); return endGame({player:alive[0].id, byCatches:true}); }
    return;
  }
  if (G.mode === 'ctf'){
    if (G.score.red >= s.scoreToWin) return endGame('red');
    if (G.score.blue >= s.scoreToWin) return endGame('blue');
    if (t >= G.endAt) return endGame(G.score.red > G.score.blue ? 'red' : G.score.blue > G.score.red ? 'blue' : 'draw');
    return;
  }
  if (!ps.some(p => p.role === 'hider' && isActive(p))) return endGame('hunter');
  if (t >= G.endAt) return endGame('hider');
}
function endGame(w, reason = ''){
  const G = H.game, g = H.group, t = now(); if (!G || G.phase !== 'running') return;
  G.phase = 'ended'; G.endedAt = t;
  const ps = Object.values(G.players), fug = G.mode === 'fugitive';
  let title, subtitle;
  if (w === 'hunter'){ title = fug ? 'Jäger gewinnen' : 'Sucher gewinnen'; subtitle = fug ? 'Der Flüchtige wurde gefangen' : 'Alle Versteckten wurden gefangen'; }
  else if (w === 'hider'){ title = fug ? 'Flüchtiger gewinnt' : 'Versteckte gewinnen'; subtitle = 'Die Zeit ist abgelaufen'; }
  else if (w === 'red' || w === 'blue'){ title = `Team ${teamName(w)} gewinnt`; subtitle = `Endstand ${G.score.red} : ${G.score.blue}`; }
  else if (w === 'draw'){ title = 'Unentschieden'; subtitle = `Endstand ${G.score.red} : ${G.score.blue}`; }
  else if (w && w.player){ const p = G.players[w.player]; title = `${p.name} gewinnt`; subtitle = w.byCatches ? `Die meisten Fänge (${p.catches})` : 'Letzter Überlebender'; }
  else { title = 'Spiel beendet'; subtitle = reason; }
  ev(title, '🏆');
  const won = p => (w === 'hunter' || w === 'hider') ? p.initialRole === w : (w === 'red' || w === 'blue') ? p.role === w : (w && w.player) ? p.id === w.player : false;
  const thin = (tr, n) => tr.length <= n ? tr : tr.filter((_, i) => i % Math.ceil(tr.length / n) === 0 || i === tr.length - 1);
  const result = {
    id:uid(8), code:g.code, groupName:g.name, mode:G.mode, startedAt:G.startedAt, endedAt:t, title, subtitle,
    winner: w && typeof w === 'object' ? 'player' : w, score:G.score, practice:!!g.practice,
    zone: G.zone ? {center:G.zone.c0, radius:G.zone.r0} : null,
    players: ps.map(p => ({id:p.id, name:p.name, role:p.role, initialRole:p.initialRole, caught:p.caught || p.initialRole !== p.role,
      caughtAt:p.caughtAt, catches:p.catches, points:p.totalPoints, distance:Math.round(p.distance), won:won(p),
      track: thin(p.track, 400).map(x => [+x.lat.toFixed(6), +x.lng.toFixed(6), x.t])})),
    events: G.events.slice(-80)
  };
  g.lastResult = {...result, players: result.players.map(p => ({...p, track:[]}))};
  g.status = 'ended'; g.gamesPlayed = (g.gamesPlayed || 0) + 1;
  deliverAll({t:'result', result});
  H.game = null;
  addChat(null, `🏆 ${title}: ${subtitle}`, null, true);
  hostBroadcastGroup();
}

/* Was darf ein Spieler sehen? */
function catchableFor(vid){
  const G = H.game, t = now(), me = G.players[vid], myPos = H.pos[vid];
  if (!me || !isActive(me) || t < G.huntStartAt || !myPos) return [];
  const out = [];
  for (const p of Object.values(G.players)){
    if (p.id === vid || !isActive(p)) continue;
    const pos = H.pos[p.id]; if (!pos) continue;
    const d = dist(myPos, pos);
    if (G.mode === 'assassin'){ if (p.id !== me.target || d > CATCH_R) continue; }
    else if (G.mode === 'ctf'){ if (p.role === me.role || d > TAG_R || territory(G, pos) !== me.role) continue; }
    else if (me.role !== 'hunter' || p.role !== 'hider' || d > CATCH_R) continue;
    if (p.immuneUntil > t || p.safe) continue;
    out.push({id:p.id, name:p.name, d:Math.round(d)});
  }
  return out.sort((a, b) => a.d - b.d);
}
function isEnemy(G, a, b){ return G.mode === 'assassin' ? a.id !== b.id : a.role !== b.role; }

function viewFor(vid){
  const G = H.game, g = H.group, s = g.settings, t = now();
  const me = G.players[vid], spect = !me, hunting = t >= G.huntStartAt;
  const vis = p => {
    if (spect || p.id === vid) return true;
    const pos = H.pos[p.id];
    if (G.mode === 'assassin') return false;
    if (G.mode === 'ctf'){
      if (p.role === me.role) return true;
      if (!pos) return false;
      if (G.flags.red.carrier === p.id || G.flags.blue.carrier === p.id) return true;
      return isActive(p) && territory(G, pos) === me.role;
    }
    if (p.role === me.role) return true;
    if (me.role === 'hunter') return hunting && isActive(p) && p.out;
    if (G.mode === 'questions') return true;
    return !(s.pingWho === 'hunter' || s.pingWho === 'both');
  };
  const players = Object.values(G.players).map(p => ({
    id:p.id, name:p.name, role:p.role, caught:!isActive(p), jail:p.jail, out:p.out, online:H.online.has(p.id) || p.bot,
    pos: vis(p) && H.pos[p.id] ? {lat:H.pos[p.id].lat, lng:H.pos[p.id].lng} : null,
    bounty: p.bountyUntil > t
  }));
  let ping = null;
  if (G.ping){
    let list = G.ping.list;
    if (!spect){
      if (G.mode === 'assassin') list = list.filter(x => x.id === me.target);
      else list = list.filter(x => x.role !== me.role);
      if (s.pingAnon) list = list.map((x, i) => ({...x, id:'anon' + i, name:'?'}));
    }
    ping = {at:G.ping.at, count:G.pingCount, list};
  }
  const bounty = spect ? G.bounty : G.bounty.filter(b => b.id !== vid && isEnemy(G, me, G.players[b.id] || {}));
  const hiders = Object.values(G.players).filter(p => p.role === 'hider');
  const memberZone = g.members[vid] && g.members[vid].personalZone;
  const v = {
    now:t, me:vid, spect, admin: vid === g.admin, mode:G.mode, groupName:g.name, code:g.code,
    startedAt:G.startedAt, huntStartAt:G.huntStartAt, endAt:G.endAt,
    nextPingAt: G.mode === 'questions' ? null : G.nextPingAt,
    questionReadyAt: G.mode === 'questions' ? G.lastQuestionAt + s.questionCooldown * MIN : null,
    zone: G.zone ? {center:G.zone.center, radius:G.zone.radius, c0:G.zone.c0, r0:G.zone.r0} : null,
    safeZones: s.zones.safeZonesAllowed ? s.zones.safeZones : [],
    myZones: me ? [
      ...(s.zones.personal && memberZone && me.zoneOffUntil <= t ? [memberZone] : []),
      ...G.extraZones.filter(z => z.owner === vid)
    ] : [],
    players, ping, bounty,
    flags: G.flags ? {red:{pos: G.flags.red.carrier && H.pos[G.flags.red.carrier] ? H.pos[G.flags.red.carrier] : G.flags.red.home, carrier:G.flags.red.carrier},
                      blue:{pos: G.flags.blue.carrier && H.pos[G.flags.blue.carrier] ? H.pos[G.flags.blue.carrier] : G.flags.blue.home, carrier:G.flags.blue.carrier}} : null,
    score:G.score, scoreToWin:s.scoreToWin,
    questions: G.questions.slice(-20),
    events: G.events.slice(-12),
    counts:{players:Object.keys(G.players).length, hunters:Object.values(G.players).filter(p => p.role === 'hunter').length,
            hidersActive:hiders.filter(isActive).length, hidersTotal:hiders.length,
            alive:Object.values(G.players).filter(isActive).length},
    abilities: s.abilities, onCaught:s.onCaught,
    my: me ? {role:me.role, caught:!isActive(me), jail:me.jail, points:me.points, totalPoints:me.totalPoints, inv:me.inv,
      immuneUntil:me.immuneUntil, cloakUntil:me.cloakUntil, bountyOnMe:me.bountyUntil > t, safe:me.safe, out:me.out, catches:me.catches,
      target: me.target && G.players[me.target] ? G.players[me.target].name : null, zoneOffUntil:me.zoneOffUntil} : null,
    catchable: me ? catchableFor(vid) : [],
    enemies: me ? Object.values(G.players).filter(p => p.id !== vid && isActive(p) && isEnemy(G, me, p)).map(p => ({id:p.id, name:p.name})) : [],
    teammatesCaught: me ? Object.values(G.players).filter(p => p.id !== vid && p.caught && G.mode !== 'assassin' && p.role === me.role).map(p => ({id:p.id, name:p.name})) : []
  };
  return v;
}
function sendViews(){
  if (!H.game) return;
  for (const id of H.online){ if (!(H.group.members[id] && H.group.members[id].bot)) deliver(id, {t:'view', view:viewFor(id)}); }
}

/* ---------- Aktionen im Spiel ---------- */
function gameAction(id, m){
  const G = H.game, p = G.players[id], t = now();
  if (!p) return;
  const tell = msg => deliver(id, {t:'toast', msg});
  switch (m.t){
    case 'catch': {
      const c = catchableFor(id).find(x => x.id === m.target);
      if (!c) return tell('Zu weit weg oder gerade geschützt.');
      applyCatch(G.players[m.target], p); break;
    }
    case 'selfCaught': {
      if (!isActive(p)) return;
      if (CLASSIC_LIKE.includes(G.mode) && p.role !== 'hider') return;
      if (p.immuneUntil > t) return tell('Du bist gerade immun.');
      let by = null;
      if (G.mode === 'assassin') by = Object.values(G.players).find(x => x.target === p.id && isActive(x)) || null;
      else {
        const pos = H.pos[id];
        const cands = Object.values(G.players).filter(x => isActive(x) && x.id !== id && isEnemy(G, p, x) && H.pos[x.id]);
        if (pos && cands.length) by = cands.sort((a, b) => dist(H.pos[a.id], pos) - dist(H.pos[b.id], pos))[0];
      }
      applyCatch(p, by); break;
    }
    case 'buy': buyItem(G, p, String(m.item), m.target, tell); break;
    case 'use': useItem(G, p, String(m.item), m.target, tell); break;
    case 'ask': askQuestion(G, p, m.q || {}, tell); break;
  }
  checkEnd(G, t);
  if (H.game && H.game.phase === 'running') sendViews();
}
function applyCatch(target, by){
  const G = H.game, t = now(), s = H.group.settings;
  if (!target || !isActive(target)) return;
  if (G.mode === 'ctf'){
    target.jail = true;
    for (const k of ['red', 'blue']) if (G.flags[k].carrier === target.id) G.flags[k].carrier = null;
    if (by){ by.catches++; by.points++; by.totalPoints++; }
    ev(`${by ? by.name : 'Jemand'} hat ${target.name} getaggt`, '🏷️');
    return;
  }
  const bonus = target.bountyUntil > t ? 3 : 0;
  if (G.mode === 'assassin'){
    target.caught = true; target.caughtAt = t;
    const hunter = by || Object.values(G.players).find(x => x.target === target.id);
    if (hunter) hunter.target = target.target !== hunter.id ? target.target : null;
  } else if (s.onCaught === 'seeker' && G.mode !== 'fugitive'){
    target.role = 'hunter'; target.caughtAt = t;
  } else { target.caught = true; target.caughtAt = t; }
  target.bountyUntil = 0;
  if (by){ by.catches++; by.points += 2 + bonus; by.totalPoints += 2 + bonus; }
  ev(`${by ? by.name : 'Jemand'} hat ${target.name} gefangen${bonus ? ' (Kopfgeld +3)' : ''}`, '🎯');
  if (s.onCaught === 'seeker' && CLASSIC_LIKE.includes(G.mode) && G.mode !== 'fugitive') ev(`${target.name} sucht jetzt mit`, '🔄');
}
function buyItem(G, p, key, targetId, tell){
  const it = ITEMS[key], t = now();
  if (!it) return;
  if (!H.group.settings.abilities) return tell('Fähigkeiten sind in diesem Spiel ausgeschaltet.');
  if (p.points < it.cost) return tell('Nicht genug Fähigkeitspunkte.');
  if (CLASSIC_LIKE.includes(G.mode) && it.side !== 'any' && it.side !== sideOf(p))
    return tell(`Nur für ${it.side === 'hunter' ? 'Sucher' : 'Versteckte'}.`);
  if (!isActive(p) && !it.inventory) return tell('Du bist gerade nicht im Spiel.');
  let target = null;
  if (it.target){
    target = G.players[targetId];
    if (!target || !isActive(target) || !isEnemy(G, p, target)) return tell('Bitte wähle einen gültigen Gegner.');
  }
  switch (key){
    case 'cloak': p.cloakUntil = Math.max(t, p.cloakUntil) + 10 * MIN; break;
    case 'immunity': p.immuneUntil = Math.max(t, p.immuneUntil) + 10 * MIN; break;
    case 'bounty': target.bountyUntil = t + 15 * MIN; G.lastBountyUpdate = 0; ev(`Kopfgeld auf ${target.name}!`, '💰'); break;
    case 'clearBounty':
      if (p.bountyUntil <= t) return tell('Auf dich ist kein Kopfgeld ausgesetzt.');
      p.bountyUntil = 0; G.lastBountyUpdate = 0; ev(`${p.name} hat das Kopfgeld gelöscht`, '🧽'); break;
    case 'revive': p.inv.revive++; break;
    case 'reboot': p.inv.reboot++; break;
    case 'extraZone': {
      const pos = H.pos[p.id]; if (!pos) return tell('Kein Standort verfügbar.');
      G.extraZones.push({owner:p.id, lat:pos.lat, lng:pos.lng, r:50}); break;
    }
    case 'disableZone': target.zoneOffUntil = t + 10 * MIN; ev(`${p.name} hat die Schutzzonen von ${target.name} abgeschaltet`, '🚫'); break;
    case 'steal':
      if (target.points < 1) return tell(`${target.name} hat gerade keine Punkte.`);
      target.points--; p.points++; ev(`${p.name} hat ${target.name} einen Punkt geklaut`, '🦝'); break;
  }
  p.points -= it.cost;
  tell(`${it.emo} ${it.name} ${it.inventory ? 'gekauft' : 'aktiviert'}!`);
}
function useItem(G, p, key, targetId, tell){
  if (key === 'revive'){
    if (!p.caught || p.inv.revive < 1) return tell('Geht gerade nicht.');
    p.caught = false; p.caughtAt = null; p.inv.revive--; p.immuneUntil = now() + 2 * MIN;
    ev(`${p.name} ist wiederbelebt`, '❤️');
  } else if (key === 'reboot'){
    const tg = G.players[targetId];
    if (p.inv.reboot < 1 || !isActive(p) || !tg || !tg.caught || tg.role !== p.role) return tell('Geht gerade nicht.');
    tg.caught = false; tg.caughtAt = null; tg.immuneUntil = now() + 2 * MIN; p.inv.reboot--;
    ev(`${p.name} hat ${tg.name} zurückgeholt`, '🔁');
  }
}
function askQuestion(G, p, q, tell){
  const s = H.group.settings, t = now(), pos = H.pos[p.id];
  if (G.mode !== 'questions' || p.role !== 'hunter' || !isActive(p)) return;
  if (t < G.huntStartAt) return tell('Der Vorsprung läuft noch.');
  if (t < G.lastQuestionAt + s.questionCooldown * MIN) return tell('Die nächste Frage ist noch nicht bereit.');
  if (!pos) return tell('Kein Standort verfügbar.');
  const hiders = Object.values(G.players).filter(x => x.role === 'hider' && isActive(x) && H.pos[x.id]);
  const r = clamp(+q.r || 500, 50, 5000);
  const text = {radar:`Ist jemand im Umkreis von ${fmtDist(r)} um mich?`, north:'Seid ihr nördlich oder südlich von mir?',
    east:'Seid ihr östlich oder westlich von mir?', distance:'Wie weit seid ihr ungefähr weg?', hotter:'Wärmer oder kälter als bei der letzten Frage?'}[q.type];
  if (!text) return;
  const answers = hiders.map((h, i) => {
    const hp = H.pos[h.id], d = dist(pos, hp); let a;
    switch (q.type){
      case 'radar': a = d <= r ? 'Ja, innerhalb' : 'Nein, außerhalb'; break;
      case 'north': a = hp.lat > pos.lat ? 'Nördlich von dir' : 'Südlich von dir'; break;
      case 'east': a = hp.lng > pos.lng ? 'Östlich von dir' : 'Westlich von dir'; break;
      case 'distance': a = 'ca. ' + fmtDist(Math.max(100, Math.round(d / 100) * 100)); break;
      case 'hotter': { const prev = G.lastDist[h.id]; a = prev == null ? 'Erste Messung, frag später nochmal' : d < prev ? 'Wärmer 🔥' : 'Kälter 🧊'; break; }
    }
    if (q.type === 'hotter' || q.type === 'distance') G.lastDist[h.id] = d;
    return {name: s.pingAnon ? `Versteckter ${i + 1}` : h.name, answer:a};
  });
  G.questions.push({at:t, by:p.name, type:q.type, r, text, answers, pos:{lat:pos.lat, lng:pos.lng}});
  G.lastQuestionAt = t;
  ev(`${p.name} fragt: ${text}`, '❓');
}

/* ---------- Bots für die Proberunde ---------- */
function botsIdle(t){ /* in der Lobby stehen die Bots still */ }
function botsTick(G, t){
  for (const p of Object.values(G.players)){
    if (!p.bot) continue;
    let pos = H.pos[p.id]; if (!pos) continue;
    if (!isActive(p)){ continue; }
    if (p.role === 'hunter'){
      if (t < G.huntStartAt) continue;
      const prey = Object.values(G.players).filter(x => x.role === 'hider' && isActive(x) && H.pos[x.id])
        .sort((a, b) => dist(H.pos[a.id], pos) - dist(H.pos[b.id], pos))[0];
      if (prey){
        const pp = H.pos[prey.id], d = dist(pos, pp);
        pos = movePos(pos, bearingTo(pos, pp), Math.min(d, 1.8));
        if (d <= BOT_CATCH_R && prey.immuneUntil <= t && !prey.safe) applyCatch(prey, p);
      }
    } else {
      p.dir = (p.dir ?? Math.random() * 6.28) + (Math.random() - .5) * .6;
      if (G.zone && dist(pos, G.zone.center) > G.zone.radius * .85) p.dir = bearingTo(pos, G.zone.center);
      pos = movePos(pos, p.dir, 1.3);
    }
    H.pos[p.id] = {lat:pos.lat, lng:pos.lng, t};
    trackPos(p.id);
  }
}
