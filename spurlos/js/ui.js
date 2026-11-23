"use strict";
/* ===== App-Zustand & Oberfläche ===== */
const APP = {
  tab:'game', group:null, online:[], gameInfo:null, view:null, chat:[], clockOff:0, myPos:null, gpsFailed:false,
  groupPage:null, zoneEdit:null, personalEdit:null, replay:null, create:null, unread:0, shopPick:null,
  lastPingCount:0, lastCaught:false, lastRole:null, lastEventT:0, profileTab:'games', currentResult:null,
  chatBuilt:null, pendingRender:false, wakeLock:null
};
const syncedNow = () => Date.now() + APP.clockOff;

/* ---------- Nachrichten vom Host ---------- */
function recv(m){
  if (!m || typeof m !== 'object') return;
  switch (m.t){
    case 'group': {
      const prev = APP.group;
      APP.group = m.group; APP.online = m.online || []; APP.gameInfo = m.game;
      if (!NET.practice){
        const local = GROUPS[m.group.code];
        GROUPS[m.group.code] = Object.assign({}, m.group, {chat: local ? local.chat || [] : APP.chat || [], lastOpened: now()});
        saveGroups();
      }
      if (!m.game && APP.view){ APP.view = null; releaseWake(); }
      if (!prev || prev.code !== m.group.code){
        const c = m.group.settings.zones.center;
        if (c && !m.game) map.setView([c.lat, c.lng], 15);
        else if (APP.myPos) map.setView([APP.myPos.lat, APP.myPos.lng], 16);
      }
      render(); break;
    }
    case 'chatHistory':
      APP.chat = m.chat || [];
      if (!NET.practice && NET.code && GROUPS[NET.code]){ GROUPS[NET.code].chat = APP.chat; saveGroups(); }
      if (APP.tab === 'chat') renderChat(true);
      break;
    case 'chat':
      APP.chat = (APP.chat || []).concat(m.msg).slice(-150);
      if (!NET.practice && NET.code && GROUPS[NET.code]){ GROUPS[NET.code].chat = APP.chat; saveGroups(); }
      if (APP.tab !== 'chat' && m.msg.from !== ME.id && !NET.practice){
        APP.unread++;
        if (!m.msg.sys) toast(`💬 ${m.msg.name}: ${m.msg.text || '📷 Foto'}`);
      }
      if (APP.tab === 'chat') renderChat(true);
      renderTabbar(); break;
    case 'view': onView(m.view); break;
    case 'result': onResult(m.result); break;
    case 'toast': case 'err': toast(m.msg); break;
  }
}

function onView(v){
  const first = !APP.view;
  APP.view = v; APP.clockOff = v.now - Date.now();
  const lastEv = v.events.length ? v.events[v.events.length - 1] : null;
  if (first){
    APP.lastPingCount = v.ping ? v.ping.count : 0;
    APP.lastCaught = !!(v.my && v.my.caught); APP.lastRole = v.my && v.my.role;
    APP.lastEventT = lastEv ? lastEv.t : 0;
    if (v.zone) fitCircle(v.zone.center, v.zone.radius);
    else if (APP.myPos) map.setView([APP.myPos.lat, APP.myPos.lng], 16);
    requestWake();
    if (v.my) toast(`Los geht’s! Du bist ${roleLabel(v.my.role, v.mode)}.`, 4000);
    APP.tab = 'game'; APP.zoneEdit = null; APP.personalEdit = null;
    render();
  } else {
    if (v.ping && v.ping.count !== APP.lastPingCount){
      APP.lastPingCount = v.ping.count;
      toast(`📡 Ping! ${v.ping.list.length ? v.ping.list.length + ' Standort(e) auf der Karte' : 'Diesmal siehst du niemanden'}`);
      vibrate([200, 100, 200]);
    }
    if (v.my){
      if (v.my.caught && !APP.lastCaught){ toast(v.my.jail ? '🏷️ Du wurdest getaggt! Zurück zur eigenen Flagge.' : '😵 Du wurdest gefangen!', 4000); vibrate([400, 100, 400]); }
      else if (APP.lastRole && v.my.role !== APP.lastRole) toast(`🔄 Du bist jetzt ${roleLabel(v.my.role, v.mode)}!`, 4000);
      APP.lastCaught = v.my.caught; APP.lastRole = v.my.role;
    }
    if (lastEv && lastEv.t > APP.lastEventT){
      APP.lastEventT = lastEv.t;
      if (/gefangen|getaggt|Punkt für|Flagge/.test(lastEv.text)) vibrate(120);
    }
  }
  if (APP.tab === 'game') renderHud();
  drawMap();
  renderLiveModal();
}

function onResult(r){
  APP.view = null; releaseWake();
  recordResult(r);
  APP.shopPick = null;
  render();
  showResult(r);
}
function recordResult(r){
  if (r.practice || PROFILE.history.some(h => h.id === r.id)) return;
  const me = r.players.find(p => p.id === ME.id); if (!me) return;
  PROFILE.history.unshift(r); PROFILE.history = PROFILE.history.slice(0, 40);
  const st = PROFILE.stats, alive = (me.caughtAt || r.endedAt) - r.startedAt;
  st.games++; st.catches += me.catches; st.distance += me.distance; st.time += r.endedAt - r.startedAt;
  if (me.won){ st.wins++; if (me.initialRole === 'hunter') st.hunterWins++; else st.hiderWins++; }
  if (me.initialRole === 'hider') st.longestSurvival = Math.max(st.longestSurvival, alive);
  saveProfile();
}

/* ---------- Standort ---------- */
function startGPS(){
  if (TEST || !navigator.geolocation){ APP.gpsFailed = true; return; }
  navigator.geolocation.watchPosition(
    p => { if (!NET.practice) setPos(p.coords.latitude, p.coords.longitude); },
    e => { APP.gpsFailed = true; if (e.code === 1) toast('Bitte erlaube den Standortzugriff – ohne Standort kannst du nicht mitspielen.', 6000); render(); },
    {enableHighAccuracy:true, maximumAge:3000, timeout:20000});
}
function setPos(lat, lng, silent){
  const first = !APP.myPos;
  APP.myPos = {lat, lng};
  if (NET.isHost && H.group){ H.pos[ME.id] = {lat, lng, t:now()}; trackPos(ME.id); }
  if (first && !APP.view && !APP.group && map.getZoom() < 5) map.setView([lat, lng], 15);
  if (!silent) drawMap();
}
setInterval(() => {
  if (!NET.isHost && NET.status === 'online' && APP.myPos && NET.conn && NET.conn.open)
    NET.conn.send({t:'pos', lat:APP.myPos.lat, lng:APP.myPos.lng});
}, 2000);
map.on('click', e => {
  if ((TEST || NET.practice || APP.gpsFailed) && !APP.zoneEdit && !APP.personalEdit && !APP.replay) setPos(e.latlng.lat, e.latlng.lng);
});

async function requestWake(){ try { if (navigator.wakeLock && !APP.wakeLock) APP.wakeLock = await navigator.wakeLock.request('screen'); } catch(e){} }
function releaseWake(){ try { APP.wakeLock && APP.wakeLock.release(); } catch(e){} APP.wakeLock = null; }

/* ---------- Uhren ---------- */
function tickClocks(){
  const sn = syncedNow();
  for (const el of $$('[data-until]')){
    const left = +el.dataset.until - sn;
    el.textContent = left > 0 ? mmss(left) : (el.dataset.zero || '00:00');
  }
  if (APP.replay){
    const R = APP.replay, lab = $('#rpLabel');
    if (lab) lab.textContent = `${mmss(R.t - R.t0)} / ${mmss(R.t1 - R.t0)}`;
  }
}
setInterval(tickClocks, 250);
setInterval(() => { if (APP.view) drawMap(); }, 20000);

/* ---------- Haupt-Render ---------- */
function pageHasFocus(sel){ const a = document.activeElement; return a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.closest(sel); }
function render(){
  renderTabbar();
  const pages = {game:'#hud', camera:'#pg-camera', chat:'#pg-chat', groups:'#pg-groups', profile:'#pg-profile'};
  for (const [k, sel] of Object.entries(pages)) $(sel).classList.toggle('hidden', k !== APP.tab);
  if (APP.tab === 'game') renderHud();
  else if (APP.tab === 'camera') renderCamera();
  else if (APP.tab === 'chat') renderChat();
  else if (APP.tab === 'groups') renderGroups();
  else if (APP.tab === 'profile') renderProfile();
  drawMap();
  renderLiveModal();
}
function renderTabbar(){
  for (const b of $$('#tabbar button')) b.classList.toggle('on', b.dataset.tab === APP.tab);
  $('#unreadDot').classList.toggle('hidden', !APP.unread);
  setHTML($('#tabAvatar'), PROFILE.photo ? `<img src="${esc(PROFILE.photo)}" alt="">` : '👤');
}

/* ---------- Spiel-Tab (Karte) ---------- */
function stat(label, until, zero){ return `<div class="st"><small>${label}</small><b data-until="${until}" ${zero ? `data-zero="${esc(zero)}"` : ''}></b></div>`; }
function statText(label, text){ return `<div class="st"><small>${label}</small><b>${esc(text)}</b></div>`; }
function groupChips(){
  const gs = Object.values(GROUPS).sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
  if (!gs.length) return '';
  return `<div class="chips">${gs.map(g => `<button class="${NET.code === g.code ? 'on' : ''}" data-a="openGroup" data-code="${esc(g.code)}">${esc(g.name)}</button>`).join('')}</div>`;
}
function renderHud(){
  const top = $('#hudTop'), bot = $('#hudBottom');
  if (APP.replay) renderReplayHud(top, bot);
  else if (APP.zoneEdit) renderZoneEditor(top, bot);
  else if (APP.personalEdit) renderPersonalEditor(top, bot);
  else if (APP.view) renderGameHud(top, bot, APP.view);
  else if (NET.status === 'connecting' || NET.status === 'lost'){
    const g = GROUPS[NET.code];
    setHTML(top, `<div class="pill">⏳ Verbinde${g ? ' mit ' + esc(g.name) : ''} …</div>`);
    setHTML(bot, `<div class="card"><b>${NET.status === 'lost' ? 'Verbindung verloren' : 'Verbinde …'}</b><p class="muted">Das dauert meist nur ein paar Sekunden.</p><button class="btn" data-a="leaveGroup">Abbrechen</button></div>`);
  }
  else if (APP.group && NET.status === 'online') renderLobbyHud(top, bot);
  else renderIdleHud(top, bot);
  tickClocks();
}
function renderIdleHud(top, bot){
  setHTML(top, `<div class="pill">🌍 ${APP.myPos ? 'Kein Spiel geöffnet' : (APP.gpsFailed ? 'Tippe auf die Karte, um deinen Standort zu setzen' : 'Suche deinen Standort …')}</div>`);
  setHTML(bot, `<div class="card stack">
    <div><div class="logo">Spur<b>los</b></div><small class="muted">Echtes Fangen mit Freunden, mitten in deiner Stadt.</small></div>
    ${groupChips()}
    <div class="row"><button class="btn primary" data-a="create">Spiel erstellen</button><button class="btn" data-a="join">Beitreten</button></div>
    <div class="links" style="margin-top:2px;flex-wrap:wrap"><button class="link" data-a="howto">So funktioniert's</button>·<button class="link" data-a="practice">Proberunde spielen</button>${installLink() ? '·' + installLink() : ''}</div>
  </div>`);
}
function lobbyInfo(g){
  const s = g.settings, isAdmin = g.admin === ME.id, me = g.members[ME.id] || {};
  const online = APP.online.map(id => g.members[id]).filter(Boolean);
  const players = online.filter(m => s.adminPlays || m.id !== g.admin);
  let head, sub = '', seekers = '–';
  const choose = s.seekerMode === 'choose';
  if (!s.adminPlays && isAdmin){ head = 'Du bist Admin'; sub = 'Du leitest das Spiel und spielst nicht mit.'; }
  else if (g.mode === 'assassin'){ head = 'Jeder jagt ein Ziel'; sub = 'Die Ziele werden beim Start zugeteilt.'; }
  else if (g.mode === 'ctf'){ head = choose ? `Du bist in Team ${me.pref === 'blue' ? 'Blau' : 'Rot'}` : 'Teams werden zufällig verteilt'; }
  else if (g.mode === 'fugitive'){ head = choose ? (me.pref === 'hider' ? 'Du willst Flüchtiger sein' : 'Du bist Jäger') : 'Der Flüchtige wird zufällig gewählt'; seekers = Math.max(0, players.length - 1); }
  else {
    if (choose){ head = `Du bist ${me.pref === 'hunter' ? 'Sucher' : 'Versteckter'}`; seekers = players.filter(m => m.pref === 'hunter').length; }
    else if (s.seekerMode === 'creator'){ head = 'Der Admin startet als Sucher'; seekers = s.seekerCount; }
    else { head = `${s.seekerCount} Sucher werden zufällig gewählt`; seekers = s.seekerCount; }
  }
  const hidersReady = choose && CLASSIC_LIKE.includes(g.mode) ? players.filter(m => m.pref !== 'hunter').length : null;
  if (hidersReady != null) sub = `${hidersReady} Versteckte${hidersReady === 1 ? 'r' : ''} bereit · ${seekers} Sucher`;
  return {players, head, sub, seekers, isAdmin, me, choose};
}
function prefSeg(g, me){
  const s = g.settings;
  if (s.seekerMode !== 'choose' || g.mode === 'assassin' || (!s.adminPlays && g.admin === ME.id)) return '';
  const opts = g.mode === 'ctf' ? [['red','🔴 Team Rot'], ['blue','🔵 Team Blau']]
    : [['hider', g.mode === 'fugitive' ? '🦊 Flüchtiger' : '🫥 Versteckter'], ['hunter', g.mode === 'fugitive' ? '🎯 Jäger' : '🎯 Sucher']];
  return `<div class="seg" style="margin-top:10px">${opts.map(([v, l]) => `<button class="${me.pref === v ? 'on ' + v : ''}" data-a="pref" data-v="${v}">${l}</button>`).join('')}</div>`;
}
function renderLobbyHud(top, bot){
  const g = APP.group, s = g.settings, L = lobbyInfo(g);
  setHTML(top, `<div class="pill">🟢 ${esc(g.name)} · ${APP.online.length} online <button data-a="invite" class="link">＋ Einladen</button></div>`);
  if (APP.gameInfo){
    setHTML(bot, `<div class="card stack"><b>🏃 Hier läuft gerade ein Spiel</b><p class="muted" style="margin:0">Du bist in dieser Runde nicht dabei. Bei der nächsten Runde kannst du mitmachen.</p>
      <div class="row"><button class="btn" data-a="tab" data-tab="chat">💬 Chat</button><button class="btn" data-a="leaveGroup">Schließen</button></div></div>${groupChips()}`);
    return;
  }
  setHTML(bot, `<div class="card">
    <div class="between"><span class="chip accent">${MODES[g.mode].emo} ${MODES[g.mode].name}</span><button class="btn small" data-a="groupPage" data-code="${esc(g.code)}">Gruppe ›</button></div>
    <h3 style="margin-top:10px">${esc(L.head)}</h3>${L.sub ? `<small class="muted">${esc(L.sub)}</small>` : ''}
    ${prefSeg(g, L.me)}
    <div class="counts"><div><b>${L.players.length}</b><small>Spieler</small></div><div><b>${L.seekers}</b><small>${g.mode === 'fugitive' ? 'Jäger' : 'Sucher'}</small></div><div><b>${APP.online.length}</b><small>Online</small></div></div>
    ${s.startAt ? `<div class="banner info" style="margin-bottom:8px">⏰ Automatischer Start um ${fmtTime(s.startAt)}</div>` : ''}
    ${L.players.length < 2 ? '<p class="muted" style="margin:0 0 8px;font-size:13px">Zum Starten braucht es mindestens 2 aktive Spieler.</p>' : ''}
    <button class="btn primary" data-a="start" ${L.players.length < 2 ? 'disabled' : ''}>▶ Jetzt starten</button>
    <div class="actions" style="margin-top:10px">
      <button class="iconbtn" data-a="tab" data-tab="chat" title="Chat">💬</button>
      <button class="iconbtn" data-a="invite" title="Einladen">➕</button>
      ${L.isAdmin ? '<button class="iconbtn" data-a="zoneEdit" title="Zonen bearbeiten">🗺️</button>' : ''}
      ${s.zones.personal ? '<button class="iconbtn" data-a="personalEdit" title="Persönliche Schutzzone">🛡️</button>' : ''}
      ${g.lastResult ? '<button class="iconbtn" data-a="lastResult" title="Letztes Ergebnis">🏆</button>' : ''}
      <button class="iconbtn" data-a="centerMe" title="Zu mir">📍</button>
      <button class="iconbtn" data-a="leaveGroup" title="Schließen">✕</button>
    </div>
  </div>${groupChips()}`);
}
function renderGameHud(top, bot, v){
  const my = v.my, sn = syncedNow(), head = sn < v.huntStartAt;
  const roleChip = v.spect ? '<span class="chip">👁️ Zuschauer</span>'
    : `<span class="chip ${my.caught ? 'caught' : my.role}">${my.caught ? (my.jail ? '⛓️ Getaggt' : '😵 Gefangen') : ROLE_ICON[my.role] + ' ' + roleLabel(my.role, v.mode)}</span>`;
  const s1 = head ? stat('Vorsprung', v.huntStartAt) : stat('Restzeit', v.endAt);
  const s2 = v.mode === 'ctf' ? statText('Punkte', `${v.score.red} : ${v.score.blue}`)
    : v.mode === 'questions' ? stat('Nächste Frage', v.questionReadyAt, 'bereit') : stat('Nächster Ping', v.nextPingAt);
  const s3 = v.mode === 'assassin' ? statText('Übrig', v.counts.alive) : v.mode === 'ctf' ? statText('Ziel', v.scoreToWin + ' Pkt')
    : statText('Übrig', `${v.counts.hidersActive}/${v.counts.hidersTotal}`);
  const ev = v.events[v.events.length - 1];
  const ticker = ev && v.now - ev.t < 90 * SEC ? `<div class="ticker">${ev.icon} ${esc(ev.text)}</div>` : '';
  setHTML(top, `<div class="card hudbar">${roleChip}${s1}${s2}${s3}</div>${ticker}`);

  const B = [];
  const classic = CLASSIC_LIKE.includes(v.mode);
  if (v.spect) B.push('<div class="banner info">👁️ Du bist Admin und schaust zu. Du siehst alle Spieler.</div>');
  if (my){
    if (head && classic) B.push(`<div class="banner info">${my.role === 'hunter' ? '⏳ Vorsprung läuft – du siehst noch niemanden. Gleich geht’s los!' : '⏳ Vorsprung: Versteck dich jetzt!'}</div>`);
    if (my.out) B.push(`<div class="banner warn">⚠️ ${sideOfRole(my.role) === 'hider' ? 'Du bist außerhalb des Spielfelds! Die Gegner sehen dich live.' : 'Du bist außerhalb des Spielfelds. Geh zurück!'}</div>`);
    if (my.safe) B.push('<div class="banner safe">🛡️ Du bist in einer Schutzzone: Hier kann dich niemand fangen.</div>');
    if (my.bountyOnMe) B.push('<div class="banner gold">💰 Auf dich ist ein Kopfgeld ausgesetzt! Dein Standort erscheint jede Minute.</div>');
    if (v.mode === 'assassin' && !my.caught) B.push(`<div class="banner info">🎯 Dein Ziel: <b>${esc(my.target || '–')}</b></div>`);
    if (v.flags && (v.flags.red.carrier === v.me || v.flags.blue.carrier === v.me)) B.push('<div class="banner gold">🚩 Du hast die Flagge! Bring sie zu deiner eigenen.</div>');
    if (my.jail) B.push('<div class="banner warn">⛓️ Getaggt! Lauf zurück zu deiner Flagge, um wieder mitzuspielen.</div>');
    else if (my.caught) B.push(`<div class="banner info">😵 Du wurdest gefangen. Du kannst weiter zuschauen.${my.inv.revive ? '' : ''}</div>`);
    const st = [];
    if (my.immuneUntil > sn) st.push(`<span class="chip hider">🛡️ Immun <b data-until="${my.immuneUntil}"></b></span>`);
    if (my.cloakUntil > sn) st.push(`<span class="chip hider">🫥 Tarnkappe <b data-until="${my.cloakUntil}"></b></span>`);
    if (my.zoneOffUntil > sn) st.push(`<span class="chip hunter">🚫 Schutzzonen aus <b data-until="${my.zoneOffUntil}"></b></span>`);
    if (st.length) B.push(`<div class="actions">${st.join('')}</div>`);
    if (my.caught && !my.jail && my.inv.revive) B.push(`<button class="btn primary" data-a="useRevive">❤️ Wiederbeleben (${my.inv.revive})</button>`);
    for (const c of v.catchable) B.push(`<button class="btn danger" data-a="catch" data-id="${esc(c.id)}">🎯 ${v.mode === 'ctf' ? 'Taggen' : 'Fangen'}: ${esc(c.name)} (${c.d} m)</button>`);
    if (!my.caught && my.inv.reboot && v.teammatesCaught.length) B.push(`<button class="btn" data-a="useReboot">🔁 Reboot-Karte nutzen (${my.inv.reboot})</button>`);
    const canSelf = !my.caught && ((classic && my.role === 'hider') || v.mode === 'assassin' || v.mode === 'ctf');
    if (canSelf) B.push(`<button class="btn ghost" data-a="selfCaught">${v.mode === 'ctf' ? 'Ich wurde getaggt' : 'Ich wurde gefangen'}</button>`);
  }
  const A = [];
  if (my && v.abilities) A.push(`<button class="iconbtn" data-a="shop" title="Fähigkeiten">⚡<span class="badge">${my.points}</span></button>`);
  if (v.mode === 'questions') A.push('<button class="iconbtn" data-a="questions" title="Fragen">❓</button>');
  A.push('<button class="iconbtn" data-a="players" title="Spieler">👥</button>');
  if (!NET.practice) A.push(`<button class="iconbtn" data-a="tab" data-tab="chat" title="Chat">💬${APP.unread ? '<span class="badge">' + APP.unread + '</span>' : ''}</button>`);
  A.push('<button class="iconbtn" data-a="centerMe" title="Zu mir">📍</button>');
  if (v.admin || NET.practice) A.push('<button class="iconbtn" data-a="endGame" title="Spiel beenden">⏹️</button>');
  B.push(`<div class="actions">${A.join('')}</div>`);
  setHTML(bot, B.join(''));
}
const sideOfRole = r => r === 'hunter' ? 'hunter' : 'hider';

/* Zonen-Editor (Admin) */
function renderZoneEditor(top, bot){
  const Z = APP.zoneEdit;
  setHTML(top, '<div class="pill">🗺️ Zonen-Editor · verschiebe die Karte zum Fadenkreuz</div>');
  setHTML(bot, `<div class="card stack">
    <div class="between"><b>Spielfeld</b><span class="chip accent" id="zeRadLabel">${Z.radius} m Radius</span></div>
    <input type="range" min="100" max="5000" step="50" value="${Z.radius}" data-in="zeRange">
    <div class="row"><button class="btn" data-a="zeCenterMap">✛ Mitte hierher</button><button class="btn" data-a="zeCenterMe">📍 Mein Standort</button></div>
    <div class="between" style="margin-top:6px"><b>Schutzzonen (${Z.safeZones.length})</b>
      <div class="row"><small class="muted">Größe ${Z.safeR} m</small><div class="stepper"><button data-a="zeSafeR" data-d="-1">−</button><button data-a="zeSafeR" data-d="1">+</button></div></div></div>
    <button class="btn" data-a="zeAddSafe">＋ Schutzzone am Fadenkreuz</button>
    ${Z.safeZones.length ? `<div class="chips">${Z.safeZones.map((z, i) => `<button data-a="zeDelSafe" data-i="${i}">🛡️ ${i + 1} · ${z.r} m ✕</button>`).join('')}</div>` : ''}
    <div class="row"><button class="btn ghost" data-a="zeCancel">Abbrechen</button><button class="btn primary" data-a="zeSave">Speichern</button></div>
  </div>`);
}
function renderPersonalEditor(top, bot){
  const P = APP.personalEdit, max = APP.group ? APP.group.settings.zones.personalMax : 200;
  setHTML(top, '<div class="pill">🛡️ Persönliche Schutzzone · nur du bist darin geschützt</div>');
  setHTML(bot, `<div class="card stack">
    <div class="between"><b>Größe</b><span class="chip hider" id="peLabel">${P.r} m</span></div>
    <input type="range" min="20" max="${max}" step="10" value="${Math.min(P.r, max)}" data-in="peRange">
    <div class="row"><button class="btn" data-a="peHere">✛ Am Fadenkreuz</button><button class="btn" data-a="peMe">📍 Mein Standort</button></div>
    <div class="row"><button class="btn ghost" data-a="peRemove">Entfernen</button><button class="btn ghost" data-a="peCancel">Abbrechen</button><button class="btn primary" data-a="peSave">Speichern</button></div>
    <small class="muted">Zum Beispiel dein Zuhause. Der Admin hat maximal ${max} m erlaubt.</small>
  </div>`);
}
function renderReplayHud(top, bot){
  const R = APP.replay, r = R.result;
  setHTML(top, `<div class="pill">🎬 Spielrückblick · ${esc(r.title)}</div>`);
  const evs = r.events.filter(e => e.t <= R.t);
  const ev = evs[evs.length - 1];
  setHTML(bot, `<div class="card stack">
    ${ev ? `<div class="ticker" style="align-self:stretch">${ev.icon} ${esc(ev.text)}</div>` : ''}
    <div class="between"><b id="rpLabel"></b><div class="row">${r.players.map(p => `<span class="chip ${p.initialRole}">${esc(p.name)}</span>`).slice(0, 4).join('')}</div></div>
    <input type="range" min="0" max="1000" value="${Math.round((R.t - R.t0) / (R.t1 - R.t0 || 1) * 1000)}" data-in="rpRange" id="rpRange">
    <div class="row"><button class="btn primary" data-a="rpToggle">${R.playing ? '⏸ Pause' : '▶ Abspielen'}</button><button class="btn" data-a="rpClose">Schließen</button></div>
  </div>`);
}
let replayTimer = null;
function startReplay(r){
  closeModal(true);
  APP.replay = {result:r, t0:r.startedAt, t1:r.endedAt, t:r.startedAt, playing:true};
  APP.tab = 'game'; fitReplay(r); render();
  clearInterval(replayTimer);
  replayTimer = setInterval(() => {
    const R = APP.replay; if (!R){ clearInterval(replayTimer); return; }
    if (!R.playing) return;
    R.t = Math.min(R.t1, R.t + (R.t1 - R.t0) / 450);
    if (R.t >= R.t1) R.playing = false;
    const rg = $('#rpRange'); if (rg && document.activeElement !== rg) rg.value = Math.round((R.t - R.t0) / (R.t1 - R.t0 || 1) * 1000);
    drawMap(); renderHud();
  }, 100);
}

/* ---------- Modals im Spiel ---------- */
function renderLiveModal(){
  const id = modalId(); if (!id) return;
  const body = $('#modalBody'); if (!body) return;
  const st = body.scrollTop;
  if (id === 'shop') setHTML(body, shopHtml());
  else if (id === 'questions') setHTML(body, questionsHtml());
  else if (id === 'players') setHTML(body, playersHtml());
  else return;
  body.scrollTop = st; tickClocks();
}
const sheetHead = (title, left = '<button class="iconbtn" data-a="closeModal">✕</button>', right = '<span style="width:44px"></span>') =>
  `<div class="sheet-head">${left}<h2>${title}</h2>${right}</div>`;
function shopHtml(){
  const v = APP.view;
  if (!v || !v.my) return sheetHead('⚡ Fähigkeiten') + '<p class="empty">Gerade läuft kein Spiel.</p>';
  const my = v.my, classic = CLASSIC_LIKE.includes(v.mode);
  if (APP.shopPick){
    const P = APP.shopPick, it = ITEMS[P.item];
    const list = P.item === 'reboot' ? v.teammatesCaught : v.enemies;
    return sheetHead(`${it.emo} ${esc(it.name)}`, '<button class="iconbtn" data-a="shopBack">‹</button>') +
      `<p class="muted">${P.item === 'reboot' ? 'Wen holst du zurück?' : 'Auf wen willst du das einsetzen?'}</p>` +
      (list.length ? list.map(p => `<button class="list-item" data-a="pickTarget" data-id="${esc(p.id)}">${avatar(p.name, null, 36)}<span class="grow title">${esc(p.name)}</span><span>›</span></button>`).join('')
        : '<p class="empty">Gerade gibt es niemanden, auf den das passt.</p>');
  }
  const items = Object.entries(ITEMS).filter(([, it]) => !classic || it.side === 'any' || it.side === sideOfRole(my.role));
  return sheetHead('⚡ Fähigkeiten') +
    `<h2 style="font-size:22px;margin-bottom:10px">Setz deine Fähigkeitspunkte klug ein</h2>
     <div class="card" style="margin-bottom:12px"><b>Deine Fähigkeitspunkte</b><p class="muted" style="margin:4px 0 0"><b style="color:var(--accent);font-size:20px">${my.points}</b> verfügbar, von insgesamt ${my.totalPoints}. Im Laufe des Spiels bekommst du mehr: Sucher für jeden Fang, Versteckte für alle 10 Minuten, die sie frei bleiben.</p></div>` +
    items.map(([k, it]) => {
      const owned = it.inventory ? my.inv[k] || 0 : null;
      const canUse = k === 'revive' ? owned && my.caught && !my.jail : k === 'reboot' ? owned && !my.caught && v.teammatesCaught.length : false;
      return `<div class="setrow"><div class="grow"><b>${it.emo} ${esc(it.name)}</b><small>${esc(it.desc)}</small>
        ${owned != null ? `<br><small>Im Besitz: ${owned}</small>` : ''}</div>
        <div class="stack" style="align-items:flex-end"><small class="muted" style="white-space:nowrap">${it.cost} Punkt${it.cost > 1 ? 'e' : ''}</small>
        ${canUse ? `<button class="btn small" data-a="${k === 'revive' ? 'useRevive' : 'useReboot'}">Nutzen</button>` : ''}
        <button class="btn small primary" data-a="buy" data-item="${k}" ${my.points < it.cost ? 'disabled' : ''}>Kaufen</button></div></div>`;
    }).join('');
}
function questionsHtml(){
  const v = APP.view;
  if (!v) return sheetHead('❓ Fragen') + '<p class="empty">Gerade läuft kein Spiel.</p>';
  const my = v.my, sn = syncedNow(), ready = sn >= v.questionReadyAt && sn >= v.huntStartAt;
  let ask = '';
  if (my && my.role === 'hunter' && !my.caught){
    const b = (type, label, r = '') => `<button class="btn" data-a="ask" data-type="${type}" data-r="${r}" ${ready ? '' : 'disabled'}>${label}</button>`;
    ask = `<div class="card stack" style="margin-bottom:12px">
      <div class="between"><b>Frage stellen</b><span class="chip ${ready ? 'accent' : ''}">${ready ? 'Bereit' : 'Bereit in <b data-until="' + Math.max(v.questionReadyAt, v.huntStartAt) + '" data-zero="0:00"></b>'}</span></div>
      <small class="muted">📡 Radar: Ist jemand im Umkreis um mich?</small>
      <div class="row">${b('radar', '100 m', 100)}${b('radar', '250 m', 250)}${b('radar', '500 m', 500)}${b('radar', '1 km', 1000)}</div>
      <div class="row">${b('north', '⬆️ Nord/Süd')}${b('east', '➡️ Ost/West')}</div>
      <div class="row">${b('distance', '📏 Entfernung')}${b('hotter', '🌡️ Wärmer/Kälter')}</div>
    </div>`;
  }
  const qs = v.questions.slice().reverse();
  return sheetHead('❓ Fragen') + ask + '<div class="section-title" style="margin-top:4px">Bisherige Fragen</div>' +
    (qs.length ? qs.map(q => `<div class="card" style="margin-bottom:8px"><small class="muted">${esc(q.by)} · ${fmtTime(q.at)}</small><b style="display:block">${esc(q.text)}</b>
      ${q.answers.length ? q.answers.map(a => `<div class="between"><span>${esc(a.name)}</span><span class="chip accent">${esc(a.answer)}</span></div>`).join('') : '<small class="muted">Keine Versteckten mehr übrig.</small>'}</div>`).join('')
      : '<p class="empty">Noch keine Fragen gestellt.</p>');
}
function playersHtml(){
  const v = APP.view;
  if (!v) return sheetHead('👥 Spieler') + '<p class="empty">Gerade läuft kein Spiel.</p>';
  return sheetHead('👥 Spieler') + v.players.map(p => `<div class="list-item">${avatar(p.name, null, 36)}<div class="grow"><div class="title">${esc(p.name)}${p.id === v.me ? ' (du)' : ''}</div>
    <div class="sub">${p.online ? '🟢 online' : '⚪ offline'}${p.out ? ' · ⚠️ außerhalb' : ''}${p.bounty ? ' · 💰 Kopfgeld' : ''}</div></div>
    <span class="chip ${p.caught ? 'caught' : p.role}">${p.caught ? (p.jail ? 'Getaggt' : 'Gefangen') : roleLabel(p.role, v.mode)}</span></div>`).join('');
}

/* ---------- Einstellungsformular ---------- */
function getPath(o, k){ return k.split('.').reduce((a, x) => a == null ? a : a[x], o); }
function setPath(o, k, v){ const ks = k.split('.'); const last = ks.pop(); ks.reduce((a, x) => a[x], o)[last] = v; }
function sfRadio(src, key, cur, opts, ed){
  return opts.map(([val, icon, title, desc]) => `<button class="opt ${String(cur) === String(val) ? 'on' : ''}" ${ed ? `data-a="sv" data-src="${src}" data-k="${key}" data-v="${val}"` : 'disabled'}>
    <i>${icon}</i><span class="grow"><b>${title}</b><small>${desc}</small></span><span class="check">✓</span></button>`).join('');
}
function sfStep(src, key, val, title, desc, unit, ed){
  return `<div class="setrow"><div class="grow"><b>${title}</b><b class="val">${val} ${unit}</b>${desc ? `<small>${desc}</small>` : ''}</div>
    ${ed ? `<div class="stepper"><button data-a="step" data-src="${src}" data-k="${key}" data-d="-1">−</button><button data-a="step" data-src="${src}" data-k="${key}" data-d="1">+</button></div>` : ''}</div>`;
}
function sfToggle(src, key, val, title, desc, ed){
  return `<div class="setrow"><div class="grow"><b>${title}</b>${desc ? `<small>${desc}</small>` : ''}</div>
    <label class="switch"><input type="checkbox" data-tg="${key}" data-src="${src}" ${val ? 'checked' : ''} ${ed ? '' : 'disabled'}><span></span></label></div>`;
}
function sfSeg(src, key, cur, opts, ed){
  return `<div class="seg">${opts.map(([v, l]) => `<button class="${cur === v ? 'on' : ''}" ${ed ? `data-a="sv" data-src="${src}" data-k="${key}" data-v="${v}"` : 'disabled'}>${l}</button>`).join('')}</div>`;
}
function settingsForm(s, mode, ed, src){
  const H2 = t => `<div class="section-title">${t}</div>`;
  let h = '';
  if (mode === 'classic' || mode === 'questions'){
    h += H2('Sucher') + sfRadio(src, 'seekerMode', s.seekerMode, [
      ['random', '🔀', 'Zufällig', 'Die Sucher werden zufällig aus den Spielern gewählt'],
      ['creator', '👑', 'Admin ist Sucher', 'Der Admin startet als Sucher, alle anderen verstecken sich'],
      ['choose', '✋', 'Spieler wählen', 'Jeder wählt selbst, ob er Versteckter oder Sucher ist']], ed);
    if (s.seekerMode !== 'choose') h += sfStep(src, 'seekerCount', s.seekerCount, 'Anzahl der Sucher', 'Die Sucher werden beim Spielstart verteilt. Mindestens ein Spieler bleibt immer Versteckter.', '', ed);
    h += H2('Wenn ein Versteckter gefangen wird') + sfRadio(src, 'onCaught', s.onCaught, [
      ['out', '🚪', 'Raus', 'Gefangene Versteckte sind für den Rest des Spiels raus'],
      ['seeker', '🔄', 'Wird Sucher', 'Gefangene Versteckte wechseln die Seite und suchen mit']], ed);
  }
  if (mode === 'fugitive') h += H2('Flüchtiger') + sfRadio(src, 'seekerMode', s.seekerMode === 'choose' ? 'choose' : 'random', [
    ['random', '🔀', 'Zufällig', 'Der Flüchtige wird zufällig gewählt'],
    ['choose', '✋', 'Freiwillig', 'Wer „Flüchtiger“ wählt, kann es werden']], ed);
  if (mode === 'ctf') h += H2('Teams') + sfRadio(src, 'seekerMode', s.seekerMode === 'choose' ? 'choose' : 'random', [
    ['random', '🔀', 'Zufällig', 'Die Teams werden gleichmäßig verteilt'],
    ['choose', '✋', 'Spieler wählen', 'Jeder wählt Team Rot oder Team Blau']], ed) +
    sfStep(src, 'scoreToWin', s.scoreToWin, 'Punkte zum Sieg', 'Wer zuerst so oft die gegnerische Flagge heimbringt, gewinnt.', '', ed);

  h += H2('Spieleinstellungen');
  h += sfStep(src, 'duration', s.duration, 'Rundendauer', 'Das Spiel endet, wenn die Zeit abläuft', 'Min.', ed);
  h += sfStep(src, 'headStart', s.headStart, 'Vorsprung', 'Bis er endet, wird niemand gefangen und Sucher sehen keine Versteckten', 'Min.', ed);
  if (mode === 'questions') h += sfStep(src, 'questionCooldown', s.questionCooldown, 'Pause zwischen Fragen', 'So lange müssen die Sucher nach jeder Frage warten', 'Min.', ed);
  else {
    h += sfStep(src, 'pingEvery', s.pingEvery, 'Pings', 'Sucher sehen Versteckte nur bei jedem Ping', 'Min.', ed);
    if (mode === 'classic' || mode === 'fugitive'){
      h += `<div class="setrow" style="display:block"><b>Wer gepingt wird</b><small class="muted">Gepingte Spieler erscheinen auf der Karte der anderen Seite. Wer nicht gepingt wird, ist für die andere Seite immer live sichtbar.</small><div style="margin-top:8px">${sfSeg(src, 'pingWho', s.pingWho, [['hider', 'Versteckte'], ['hunter', 'Sucher'], ['both', 'Beide']], ed)}</div></div>`;
    }
    h += sfToggle(src, 'pingFaster', s.pingFaster, 'Pings werden schneller', 'Jeder Ping kommt etwas früher als der letzte', ed);
  }
  h += sfToggle(src, 'pingAnon', s.pingAnon, 'Anonyme Pings', 'Gepingte Spieler erscheinen als anonyme Pins, ohne Namen', ed);
  h += sfToggle(src, 'abilities', s.abilities, 'Fähigkeitspunkte & Shop', 'Punkte sammeln und Fähigkeiten wie Tarnkappe, Kopfgeld oder Wiederbeleben kaufen', ed);

  const z = s.zones;
  h += H2('🗺️ Zonen-Editor');
  h += sfToggle(src, 'zones.enabled', z.enabled, 'Zonen aktivieren', 'Ein Spielfeld, das man nicht verlassen darf', ed);
  if (z.enabled) h += sfStep(src, 'zones.radius', z.radius, 'Radius des Spielfelds', z.center ? 'Mittelpunkt ist gesetzt' : 'Mittelpunkt: Standort der Spieler beim Start', 'm', ed);
  h += sfToggle(src, 'zones.safeZonesAllowed', z.safeZonesAllowed, 'Schutzzonen erlauben', `Bereiche, in denen Versteckte nicht gefangen werden${z.safeZones.length ? ` (${z.safeZones.length} gesetzt)` : ''}`, ed);
  h += sfToggle(src, 'zones.wandering', z.wandering, 'Wandernde Zone', 'Das Spielfeld verschiebt sich langsam', ed);
  h += sfToggle(src, 'zones.shrinking', z.shrinking, 'Schrumpfende Zone', 'Das Spielfeld wird bis zum Ende immer kleiner', ed);
  h += sfToggle(src, 'zones.personal', z.personal, 'Persönliche Schutzzonen', 'Jedes Mitglied kann seinen eigenen Schutzbereich setzen, z. B. das eigene Zuhause', ed);
  if (z.personal) h += sfStep(src, 'zones.personalMax', z.personalMax, 'Max. Größe persönlicher Schutzzonen', '', 'm', ed);

  h += H2('Deine Rolle im Spiel') + sfRadio(src, 'adminPlays', s.adminPlays, [
    [true, '🎮', 'Mitspielen', 'Du spielst selbst mit'],
    [false, '👑', 'Nur Admin', 'Du leitest das Spiel und schaust zu, ohne mitzuspielen']], ed);

  h += sfToggle(src, 'startAtOn', !!s.startAt, 'Startzeit planen', 'Das Spiel startet automatisch, wenn der Host online ist', ed);
  if (s.startAt){
    const d = new Date(s.startAt), local = new Date(d.getTime() - d.getTimezoneOffset() * MIN).toISOString().slice(0, 16);
    h += `<input type="datetime-local" value="${local}" data-in="startAt" data-src="${src}" ${ed ? '' : 'disabled'} style="margin-bottom:6px">`;
  }
  return h;
}
function parseVal(v){ return v === 'true' ? true : v === 'false' ? false : (v !== '' && !isNaN(v) ? Number(v) : v); }
function settingsOf(src){ return src === 'c' ? APP.create.settings : APP.group.settings; }
function applySetting(src, key, val){
  if (key === 'startAtOn'){ key = 'startAt'; val = val ? now() + 30 * MIN : null; }
  if (src === 'c'){
    const s = structuredClone(APP.create.settings); setPath(s, key, val);
    APP.create.settings = sanitizeSettings(s, APP.create.mode); renderCreate();
  } else {
    const patch = {};
    if (key.startsWith('zones.')) patch.zones = {[key.slice(6)]: val}; else patch[key] = val;
    send({t:'settings', patch});
  }
}

/* ---------- Gruppen-Tab ---------- */
function groupStatus(g){
  if (NET.code === g.code && NET.status === 'online') return APP.gameInfo ? '🏃 Läuft' : '🟢 Verbunden';
  return g.status === 'running' ? 'Läuft' : g.status === 'ended' ? 'Beendet' : 'Nicht gestartet';
}
function renderGroups(){
  const page = $('#pg-groups');
  if (pageHasFocus('#pg-groups')){ APP.pendingRender = true; return; }
  if (APP.groupPage) return renderGroupPage(page, APP.groupPage);
  const gs = Object.values(GROUPS).sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
  setHTML(page, `<div class="wrap">
    <div class="between"><div class="logo">Spur<b>los</b></div><button class="iconbtn" data-a="tab" data-tab="profile">⚙️</button></div>
    <div class="gap"></div>
    <h1 style="font-size:30px">Deine Spiele <span class="chip">${gs.length}</span></h1><div class="gap"></div>
    ${gs.length ? gs.map(g => `<button class="list-item" data-a="groupPage" data-code="${esc(g.code)}">${avatar(g.name, null, 46)}
      <div class="grow"><div class="title">${esc(g.name)}</div>
      <div class="sub"><span class="chip accent">${MODES[g.mode] ? MODES[g.mode].name : ''}</span> ${groupStatus(g)}</div>
      <div class="sub">👥 ${Object.keys(g.members || {}).length} Mitglieder${g.admin === ME.id ? ' · 👑 Admin' : ''}</div></div><span>›</span></button>`).join('')
      : '<div class="empty">Du bist noch in keiner Gruppe.<br>Erstelle ein Spiel oder tritt mit einem Code bei.</div>'}
    <div class="gap"></div>
    <button class="btn primary" data-a="create">Spiel erstellen</button><div style="height:8px"></div>
    <button class="btn" data-a="join">Spiel beitreten</button>
    <div class="links"><button class="link" data-a="howto">So funktioniert's</button>·<button class="link" data-a="practice">Proberunde spielen</button></div>
  </div>`);
}
function renderGroupPage(page, code){
  const live = NET.code === code && NET.status === 'online' && APP.group && APP.group.code === code;
  const g = live ? APP.group : GROUPS[code];
  if (!g){
    if (NET.code === code){ setHTML(page, `<div class="wrap"><button class="iconbtn" data-a="groupBack">‹</button><div class="empty">⏳ Verbinde mit ${esc(code)} …</div></div>`); return; }
    APP.groupPage = null; return renderGroups();
  }
  const s = g.settings, isAdmin = g.admin === ME.id, me = (g.members || {})[ME.id] || {};
  const members = Object.values(g.members || {});
  const editable = isAdmin && live && !APP.gameInfo;
  let status = '';
  if (live){
    const L = lobbyInfo(g);
    status = APP.gameInfo
      ? `<div class="card stack"><b>🏃 Spiel läuft</b>${APP.view ? '<button class="btn primary" data-a="tab" data-tab="game">Zur Karte</button>' : '<small class="muted">Du bist in dieser Runde nicht dabei.</small>'}</div>`
      : `<div class="card"><div class="between"><h3>${esc(L.head)}</h3><span class="chip">${APP.online.length} online</span></div>${L.sub ? `<small class="muted">${esc(L.sub)}</small>` : ''}
        ${prefSeg(g, me)}
        <div class="counts"><div><b>${L.players.length}</b><small>Spieler</small></div><div><b>${L.seekers}</b><small>Sucher</small></div><div><b>${members.length}</b><small>Mitglieder</small></div></div>
        ${L.players.length < 2 ? '<p class="muted" style="margin:0 0 8px;font-size:13px">Zum Starten braucht es mindestens 2 aktive Spieler.</p>' : ''}
        <button class="btn primary" data-a="start" ${L.players.length < 2 ? 'disabled' : ''}>▶ Jetzt starten</button></div>`;
  } else {
    status = `<div class="card stack"><b>${NET.code === code ? '⏳ Verbinde …' : '⚪ Nicht verbunden'}</b>${NET.code === code ? '' : `<button class="btn primary" data-a="openGroup" data-code="${esc(code)}">Verbinden</button>`}</div>`;
  }
  const hist = g.lastResult ? `<button class="list-item" data-a="lastResult" data-code="${esc(code)}"><span style="font-size:26px">🏆</span><div class="grow"><div class="title">${esc(g.lastResult.title)}</div><div class="sub">Letztes Spiel · ${fmtDate(g.lastResult.endedAt)}</div></div><span class="link">Ergebnisse ›</span></button>` : '';
  setHTML(page, `<div class="wrap">
    <div class="between"><button class="iconbtn" data-a="groupBack">‹</button><button class="btn small" data-a="invite" data-code="${esc(code)}">＋ Einladen</button></div>
    <div class="row" style="margin-top:12px">${avatar(g.name, null, 60)}<div class="grow">
      <h1 style="font-size:24px">${esc(g.name)} ${editable ? '<button class="link" style="font-size:14px" data-a="renameGroup">✎</button>' : ''}</h1>
      <div class="sub"><span class="chip accent">${MODES[g.mode].emo} ${MODES[g.mode].name}</span> <span class="chip">${groupStatus(g)}</span> <small class="muted">${members.length} Mitglieder</small></div></div></div>
    <p class="muted">${MODES[g.mode].short}</p>
    ${status}${hist ? '<div class="gap"></div>' + hist : ''}
    <div class="section-title">Hausregeln</div>
    <div class="card"><div style="white-space:pre-wrap">${g.rules ? esc(g.rules) : '<span class="muted">Noch keine Hausregeln. Schreib alles auf, was die Spieler wissen sollten.</span>'}</div>
      ${isAdmin && live ? '<div style="margin-top:8px"><button class="link" data-a="editRules">Bearbeiten</button></div>' : ''}</div>
    <div class="section-title">Mein Gruppenprofil</div>
    ${live ? prefSeg(g, me) : ''}
    <div class="setrow" style="margin-top:6px"><div class="grow"><b>Spitzname</b><small>Wird nur in dieser Gruppe angezeigt</small></div>${live ? `<button class="link" data-a="editNick">${esc(me.nick || me.name || PROFILE.name)} ✎</button>` : `<span>${esc(me.nick || PROFILE.name)}</span>`}</div>
    ${s.zones.personal ? `<button class="setrow" style="width:100%;text-align:left" ${live ? 'data-a="personalEdit"' : 'disabled'}><div class="grow"><b>Persönliche Schutzzone</b><small>${me.personalZone ? me.personalZone.r + ' m gesetzt' : 'Noch keine gesetzt'} · max. ${s.zones.personalMax} m</small></div><span>›</span></button>` : ''}
    <div class="section-title">Mitglieder (${members.length})</div>
    ${members.map(m => `<div class="list-item">${avatar(m.nick || m.name, m.avatar, 38)}<div class="grow"><div class="title">${esc(m.nick || m.name)}${m.id === ME.id ? ' (du)' : ''} ${m.id === g.admin ? '👑' : ''}</div>
      <div class="sub">${live ? (APP.online.includes(m.id) ? '🟢 online' : '⚪ offline') : ''}${m.nick ? ' · ' + esc(m.name) : ''}</div></div>
      ${s.seekerMode === 'choose' && g.mode !== 'assassin' ? `<span class="chip ${m.pref}">${roleLabel(m.pref, g.mode)}</span>` : ''}</div>`).join('')}
    <div class="section-title">Spieleinstellungen ${isAdmin ? '' : '<small>(nur der Admin kann sie ändern)</small>'}</div>
    ${settingsForm(s, g.mode, editable, 'g')}
    ${editable ? '<div class="gap"></div><button class="btn" data-a="zoneEdit">🗺️ Zonen auf der Karte bearbeiten</button>' : ''}
    <div class="section-title">So gewinnst du</div>
    ${HOW_TO_WIN[g.mode].map(([r, l, t]) => `<div class="card" style="margin-bottom:6px"><span class="chip ${r}">${esc(l)}</span><p style="margin:6px 0 0">${esc(t)}</p></div>`).join('')}
    <div class="gap"></div><button class="btn ghost" data-a="removeGroup" data-code="${esc(code)}" style="color:var(--hunter)">Gruppe verlassen</button>
  </div>`);
}

/* ---------- Spiel erstellen ---------- */
function renderCreate(){
  const C = APP.create; if (!C) return;
  const body = $('#modalBody'); if (!body || modalId() !== 'create') return;
  const st = body.scrollTop;
  if (C.step === 1){
    setHTML(body, sheetHead('Spiel erstellen', '<button class="iconbtn" data-a="closeModal">✕</button>') +
      Object.entries(MODES).map(([k, m]) => `<button class="mode m-${k}" data-a="createMode" data-mode="${k}"><h3>${m.name}</h3><p>${m.short}</p><span class="emo">${m.emo}</span></button>`).join(''));
  } else {
    setHTML(body, sheetHead('Spiel erstellen', '<button class="iconbtn" data-a="createBack">‹</button>') +
      `<button class="mode m-${C.mode}" data-a="createBack" style="min-height:70px"><h3>${MODES[C.mode].name}</h3><p>${MODES[C.mode].short} · Ändern</p><span class="emo">${MODES[C.mode].emo}</span></button>
       <input id="cName" data-in="cName" maxlength="30" placeholder="Gruppenname eingeben" value="${esc(C.name)}">` +
      settingsForm(C.settings, C.mode, true, 'c') +
      `<div class="gap"></div><small class="muted">Weitere Einstellungen kannst du nach dem Erstellen der Gruppe im Tab „Gruppen“ ändern.</small><div class="gap"></div>
       <button class="btn primary" data-a="createGo">Spiel erstellen</button>`);
  }
  body.scrollTop = st;
}

/* ---------- Chat ---------- */
function renderChat(scroll){
  const page = $('#pg-chat');
  const live = NET.status === 'online' && NET.code && !NET.practice && APP.group;
  APP.unread = 0; renderTabbar();
  if (!live){
    APP.chatBuilt = null;
    page.style.display = '';
    const gs = Object.values(GROUPS).sort((a, b) => ((b.chat || []).slice(-1)[0] || {t:0}).t - ((a.chat || []).slice(-1)[0] || {t:0}).t);
    setHTML(page, `<div class="wrap"><h1 style="font-size:30px">Nachrichten</h1><div class="gap"></div>
      ${gs.length ? gs.map(g => { const l = (g.chat || []).slice(-1)[0];
        return `<button class="list-item" data-a="openChat" data-code="${esc(g.code)}">${avatar(g.name, null, 44)}<div class="grow"><div class="title">${esc(g.name)}</div>
          <div class="sub">${l ? esc((l.name ? l.name + ': ' : '') + (l.text || '📷 Foto')) : 'Noch keine Nachrichten'}</div></div><small class="muted">${l ? fmtTime(l.t) : ''}</small></button>`; }).join('')
        : '<div class="empty">Tritt einer Gruppe bei, um zu chatten.</div>'}
      <p class="muted" style="font-size:13px">Tippe auf eine Gruppe, um dich zu verbinden und mitzuschreiben.</p></div>`);
    return;
  }
  if (APP.chatBuilt !== NET.code){
    page._h = null;
    page.innerHTML = `<div class="wrap chat">
      <div class="chat-head between"><div><b id="chatTitle"></b><br><small class="muted" id="chatSub"></small></div><button class="iconbtn" data-a="groupPage" data-code="${esc(NET.code)}">ℹ️</button></div>
      <div class="msgs" id="msgs"></div>
      <div class="chat-input"><button class="iconbtn" data-a="chatPhoto">📷</button><input id="chatText" placeholder="Nachricht …" maxlength="500" autocomplete="off"><button class="iconbtn" data-a="chatSend" style="background:var(--accent);color:var(--accent-ink)">➤</button></div>
    </div>`;
    APP.chatBuilt = NET.code; scroll = true;
  }
  $('#chatTitle').textContent = APP.group.name;
  $('#chatSub').textContent = `${APP.online.length} online · ${Object.keys(APP.group.members).length} Mitglieder`;
  const box = $('#msgs'), near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  setHTML(box, (APP.chat || []).map(m => m.sys ? `<div class="msg sys">${esc(m.text)} · ${fmtTime(m.t)}</div>`
    : `<div class="msg ${m.from === ME.id ? 'mine' : ''}">${m.from !== ME.id ? `<span class="who">${esc(m.name)}</span>` : ''}${m.text ? esc(m.text) : ''}${m.img ? `<img src="${esc(m.img)}" data-a="viewImg" alt="Foto">` : ''}<time>${fmtTime(m.t)}</time></div>`).join('')
    || '<div class="empty">Noch keine Nachrichten. Sag hallo! 👋</div>');
  if (scroll || near) box.scrollTop = box.scrollHeight;
}

/* ---------- Kamera ---------- */
function renderCamera(){
  const ph = PROFILE.photos.slice().reverse();
  setHTML($('#pg-camera'), `<div class="wrap"><h1 style="font-size:30px">Kamera</h1>
    <p class="muted">Halte die besten Momente fest, zum Beispiel als Beweis für einen Fang, und schick sie an deine Gruppe.</p>
    <button class="btn primary" data-a="takePhoto" style="padding:30px;font-size:18px">📸 Foto aufnehmen</button><div style="height:8px"></div>
    <button class="btn" data-a="pickPhoto">🖼️ Aus der Galerie wählen</button>
    <div class="section-title">Aufnahmen (${ph.length})</div>
    ${ph.length ? `<div class="grid3">${ph.map(p => `<img src="${esc(p.data)}" data-a="viewPhoto" data-id="${esc(p.id)}" alt="">`).join('')}</div>` : '<div class="empty">Noch keine Aufnahmen.</div>'}
  </div>`);
}
async function addPhoto(capture){
  const f = await pickImage(capture); if (!f) return;
  try {
    const data = await compressImage(f, 1000, .7);
    const p = {id:uid(6), data, t:now(), group:NET.code};
    PROFILE.photos.push(p); PROFILE.photos = PROFILE.photos.slice(-40); saveProfile();
    render(); viewPhoto(p.id);
  } catch(e){ toast('Das Foto konnte nicht geladen werden.'); }
}
function viewPhoto(id){
  const p = PROFILE.photos.find(x => x.id === id); if (!p) return;
  const live = NET.status === 'online' && !NET.practice && APP.group;
  openModal(sheetHead('Aufnahme') + `<img src="${esc(p.data)}" style="width:100%;border-radius:14px" alt=""><p class="muted">${fmtDate(p.t)}</p>
    <div class="stack">${live ? `<button class="btn primary" data-a="sendPhoto" data-id="${esc(id)}">An „${esc(APP.group.name)}“ senden</button>` : '<small class="muted">Öffne eine Gruppe, um das Foto zu senden.</small>'}
    <button class="btn ghost" data-a="delPhoto" data-id="${esc(id)}" style="color:var(--hunter)">Löschen</button></div>`, {id:'photo'});
}

/* ---------- Profil ---------- */
function renderProfile(){
  const st = PROFILE.stats, pct = st.games ? Math.round(st.wins / st.games * 100) : 0;
  const T = APP.profileTab;
  let content = '';
  if (T === 'games'){
    const hs = PROFILE.history;
    if (!hs.length) content = '<div class="empty">Noch keine Spiele. Starte eine Runde mit deinen Freunden!</div>';
    else {
      let month = '';
      for (const r of hs){
        const me = r.players.find(p => p.id === ME.id) || {};
        const m = fmtMonth(r.endedAt);
        if (m !== month){ month = m; content += `<div class="section-title">${esc(m)}</div>`; }
        const res = me.won ? `Gewonnen · ${roleLabel(me.initialRole, r.mode)}` : me.caughtAt ? `Gefangen bei ${mmss(me.caughtAt - r.startedAt)}` : 'Verloren';
        content += `<button class="list-item game-item ${me.won ? 'won' : 'lost'}" data-a="openHistory" data-id="${esc(r.id)}">${avatar(r.groupName, null, 40)}
          <div class="grow"><div class="between"><span class="title">${esc(r.groupName)}</span><small style="color:${me.won ? 'var(--accent)' : 'var(--hunter)'};font-weight:700">${esc(res)}</small></div>
          <div class="sub">${MODES[r.mode] ? MODES[r.mode].name : ''} · ${fmtDate(r.endedAt)}</div>
          <div class="sub">${me.catches || 0} Fänge · ${fmtKm(me.distance || 0)} km · ${mmss(r.endedAt - r.startedAt)} gespielt</div></div></button>`;
      }
    }
  } else if (T === 'photos'){
    const ph = PROFILE.photos.slice().reverse();
    content = ph.length ? `<div class="grid3" style="margin-top:12px">${ph.map(p => `<img src="${esc(p.data)}" data-a="viewPhoto" data-id="${esc(p.id)}" alt="">`).join('')}</div>` : '<div class="empty">Noch keine Aufnahmen.</div>';
  } else {
    const row = (l, v) => `<div class="setrow"><span>${l}</span><b>${v}</b></div>`;
    content = '<div class="gap"></div>' + row('Gesamtstrecke', fmtKm(st.distance) + ' km') + row('Gespielte Zeit', mmss(st.time)) +
      row('Siege als Sucher', st.hunterWins) + row('Siege als Versteckter', st.hiderWins) + row('Längste Zeit frei', mmss(st.longestSurvival)) +
      row('Fänge pro Spiel', st.games ? (st.catches / st.games).toFixed(1).replace('.', ',') : '0');
  }
  setHTML($('#pg-profile'), `<div class="wrap">
    <div class="profile-head">
      <button data-a="editProfile">${avatar(PROFILE.name || '?', PROFILE.photo, 84)}</button>
      <h1 style="margin-top:8px">${esc(PROFILE.name || 'Ohne Namen')}</h1>
      <button class="btn small" data-a="editProfile" style="margin:10px auto 0;background:#fff;color:#0b0f14">Profil bearbeiten</button>
      <div class="stats4"><div><b>${st.games}</b><small>Spiele</small></div><div><b>${st.wins}</b><small>Siege</small></div><div><b>${st.catches}</b><small>Fänge</small></div><div><b>${pct} %</b><small>Siege %</small></div></div>
    </div><div class="gap"></div>
    <div class="seg">${[['games', 'Spiele'], ['photos', 'Aufnahmen'], ['stats', 'Statistik']].map(([k, l]) => `<button class="${T === k ? 'on' : ''}" data-a="ptab" data-v="${k}">${l}</button>`).join('')}</div>
    ${content}
    <div class="section-title">App</div>
    <div class="setrow"><div class="grow"><b>Standort</b><small>${APP.gpsFailed ? (TEST ? 'Testmodus: Tippe auf die Karte, um dich zu bewegen' : 'Nicht verfügbar. Erlaube den Standortzugriff in den Browser-Einstellungen.') : APP.myPos ? 'Aktiv' : 'Wird gesucht …'}</small></div></div>
    ${isStandalone() ? '' : '<button class="btn primary" data-a="install">📲 Als App installieren</button><div style="height:8px"></div>'}
    <button class="btn ghost" data-a="howto">So funktioniert's</button><div style="height:8px"></div>
    <button class="btn ghost" data-a="resetAll" style="color:var(--hunter)">Alle Daten auf diesem Gerät löschen</button>
  </div>`);
}

/* ---------- Ergebnisse ---------- */
function survivalText(r, p){
  if (p.initialRole === 'hunter') return `${p.catches} Fänge`;
  if (p.caughtAt) return `Nach ${mmss(p.caughtAt - r.startedAt)} ${r.mode === 'ctf' ? 'getaggt' : 'gefangen'}`;
  return 'Bis zum Ende frei 🎉';
}
function showResult(r){
  APP.currentResult = r;
  const me = r.players.find(p => p.id === ME.id), won = me ? me.won : true, dur = r.endedAt - r.startedAt;
  const winners = r.players.filter(p => p.won);
  const totalCatches = r.players.reduce((a, p) => a + p.catches, 0);
  const html = sheetHead('Ergebnisse', '<button class="iconbtn" data-a="closeModal">⌄</button>', '<button class="iconbtn" data-a="shareResult">↗</button>') +
    `<div class="result-hero ${won ? '' : 'lost'}">
      <small class="muted">${esc(r.groupName)} · ${MODES[r.mode] ? MODES[r.mode].name : ''}</small>
      <h1>${esc(r.title)}</h1><p style="margin:0 0 10px">${esc(r.subtitle)}</p>
      ${winners.length ? `<div class="row" style="justify-content:center">${winners.slice(0, 6).map(p => avatar(p.name, null, 42)).join('')}</div><small>${winners.map(p => esc(p.name)).join(', ')}</small>` : ''}
      <div class="row" style="justify-content:center;flex-wrap:wrap;margin-top:12px"><span class="chip">⏱ ${mmss(dur)} lang</span><span class="chip">👥 ${r.players.length} Spieler</span><span class="chip">🏁 ${fmtDate(r.endedAt)}</span></div>
    </div>` +
    (me ? `<div class="section-title">Deine Karte</div>
      <div class="mapcard ${me.initialRole === 'hunter' ? 'hunter' : ''}"><small>${esc(roleLabel(me.initialRole, r.mode).toUpperCase())}</small><h2>${esc(me.name)} (du)</h2>
      <canvas id="routeCanvas" width="600" height="400"></canvas><h3>${esc(survivalText(r, me))}</h3><div class="gap" style="height:8px"></div>
      <div class="mapstats"><div><b>${fmtKm(me.distance)} km</b><small>Strecke</small></div><div><b>${mmss((me.caughtAt || r.endedAt) - r.startedAt)}</b><small>${me.caughtAt ? 'bis gefangen' : 'im Spiel'}</small></div><div><b>${me.catches}</b><small>Fänge</small></div></div></div>
      <div class="gap" style="height:8px"></div><button class="btn" data-a="shareCard">📤 Deine Karte teilen</button>` : '') +
    `<div style="height:8px"></div><button class="btn primary" data-a="replay">▶ Spielrückblick · ${totalCatches} Fänge, von Anfang bis Ende</button>
    <div class="section-title">So lief es</div>
    <ul class="timeline">${r.events.map(e => `<li><time>${mmss(e.t - r.startedAt)}</time><span>${e.icon}</span><span>${esc(e.text)}</span></li>`).join('')}</ul>
    <div class="section-title">Alle Spieler</div>
    ${r.players.map(p => `<div class="list-item">${avatar(p.name, null, 38)}<div class="grow"><div class="title">${esc(p.name)}${p.id === ME.id ? ' (du)' : ''} ${p.won ? '🏆' : ''}</div>
      <div class="sub">${esc(survivalText(r, p))} · ${fmtKm(p.distance)} km</div></div><span class="chip ${p.initialRole}">${roleLabel(p.initialRole, r.mode)}</span></div>`).join('')}
    <div class="gap"></div><button class="btn" data-a="shareResult">Ergebnisse teilen</button>`;
  openModal(html, {full:true, id:'result'});
  if (me) drawRoute($('#routeCanvas'), me.track, {color:'#fff'});
}
async function shareCard(){
  const r = APP.currentResult, me = r && r.players.find(p => p.id === ME.id); if (!me) return;
  const c = document.createElement('canvas'); c.width = 1080; c.height = 1350;
  const x = c.getContext('2d');
  const gr = x.createLinearGradient(0, 0, 1080, 1350);
  gr.addColorStop(0, me.initialRole === 'hunter' ? '#8d2230' : '#1f6f3f'); gr.addColorStop(1, '#0b0f14');
  x.fillStyle = gr; x.fillRect(0, 0, 1080, 1350);
  x.fillStyle = '#fff'; x.font = '800 44px system-ui'; x.fillText(roleLabel(me.initialRole, r.mode).toUpperCase(), 70, 110);
  x.font = '900 84px system-ui'; x.fillText(me.name, 70, 200);
  const rc = document.createElement('canvas'); rc.width = 940; rc.height = 700;
  drawRoute(rc, me.track, {color:'#fff', bg:'rgba(0,0,0,.3)'}); x.drawImage(rc, 70, 250);
  x.font = '800 60px system-ui'; x.fillText(survivalText(r, me), 70, 1040);
  x.font = '600 40px system-ui'; x.fillStyle = '#d8e0e8';
  x.fillText(`${fmtKm(me.distance)} km  ·  ${mmss((me.caughtAt || r.endedAt) - r.startedAt)}  ·  ${me.catches} Fänge`, 70, 1110);
  x.fillText(`${r.title} · ${r.groupName}`, 70, 1170);
  x.fillStyle = '#b6f23a'; x.font = '900 56px system-ui'; x.fillText('Spurlos', 70, 1280);
  const blob = await new Promise(res => c.toBlob(res, 'image/png'));
  const file = new File([blob], 'spurlos-karte.png', {type:'image/png'});
  try {
    if (navigator.canShare && navigator.canShare({files:[file]})) { await navigator.share({files:[file], title:'Meine Spurlos-Karte'}); return; }
  } catch(e){ if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'spurlos-karte.png'; a.click();
  toast('Bild gespeichert.');
}
async function shareText(text, url){
  try { if (navigator.share){ await navigator.share({title:'Spurlos', text, url}); return; } } catch(e){ if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url ? text + '\n' + url : text); toast('In die Zwischenablage kopiert.'); } catch(e){ toast(text); }
}
const joinLink = code => location.origin + location.pathname + '?join=' + encodeURIComponent(code);

/* ---------- Dialoge ---------- */
function ensureName(){
  if (PROFILE.name) return Promise.resolve();
  return new Promise(res => {
    openModal(`<div style="text-align:center"><div class="logo" style="font-size:38px">Spur<b>los</b></div><p class="muted">Echtes Fangen mit Freunden. Wie sollen dich die anderen sehen?</p></div>
      <input id="onbName" maxlength="20" placeholder="Dein Name" autocomplete="off"><div class="gap"></div>
      <button class="btn primary" id="onbGo">Los geht’s</button>`, {id:'onboarding', center:true, locked:true});
    const go = () => {
      const n = $('#onbName').value.trim();
      if (n.length < 2){ toast('Bitte gib mindestens 2 Zeichen ein.'); return; }
      PROFILE.name = n.slice(0, 20); saveProfile(); closeModal(true); render(); res();
    };
    $('#onbGo').onclick = go;
    $('#onbName').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    setTimeout(() => $('#onbName').focus(), 100);
  });
}
function showInvite(code){
  openModal(sheetHead('Einladen') + `<p class="muted" style="text-align:center">Teile diesen Einladungscode, damit andere deiner Gruppe beitreten können:</p>
    <div class="bigcode">${esc(code)}</div>
    <button class="btn primary" data-a="shareCode" data-code="${esc(code)}">Code teilen</button><div class="gap"></div>
    <div class="card"><b>📱 Läuft auf jedem Handy</b><p class="muted" style="margin:4px 0">Spurlos läuft im Browser, auf iPhone und Android. Deine Freunde öffnen einfach diesen Link:</p><small class="link" style="word-break:break-all">${esc(joinLink(code))}</small></div>`, {id:'invite'});
}
function showJoin(prefill = ''){
  openModal(sheetHead('Spiel beitreten') + `<p class="muted">Gib den Einladungscode ein, den du bekommen hast:</p>
    <input id="joinCodeInput" class="bigcode" style="font-size:30px;padding:14px" maxlength="7" placeholder="ABC-123" value="${esc(prefill)}" autocomplete="off">
    <div class="gap"></div><button class="btn primary" data-a="joinGo">Beitreten</button>`, {id:'join'});
  setTimeout(() => { const i = $('#joinCodeInput'); if (i) i.focus(); }, 100);
}
function showHowTo(){
  openModal(sheetHead("So funktioniert's") + `
    <div class="card stack">
      <div><b>1. Gruppe erstellen</b><p class="muted" style="margin:2px 0">Wähle einen Spielmodus, gib der Gruppe einen Namen und stell die Regeln ein.</p></div>
      <div><b>2. Freunde einladen</b><p class="muted" style="margin:2px 0">Teile den Code. Deine Freunde treten über „Spiel beitreten“ bei.</p></div>
      <div><b>3. Spielfeld festlegen</b><p class="muted" style="margin:2px 0">Der Admin legt im Zonen-Editor Radius und Schutzzonen fest. Wer das Spielfeld verlässt, wird sichtbar.</p></div>
      <div><b>4. Rausgehen und spielen</b><p class="muted" style="margin:2px 0">Pings verraten regelmäßig die Standorte. Wer in 30 m Nähe ist, kann gefangen werden.</p></div>
      <div><b>5. Ergebnisse ansehen</b><p class="muted" style="margin:2px 0">Nach dem Spiel siehst du deine Route, die Statistik und den Spielrückblick.</p></div>
    </div>
    <div class="section-title">Wichtig</div>
    <p class="muted">Lass die App während des Spiels geöffnet und den Bildschirm an, sonst wird dein Standort nicht gesendet. Wer die Gruppe zuerst öffnet, ist ihr „Server“. Achtet auf den Verkehr und spielt nur dort, wo es erlaubt ist.</p>
    <button class="btn primary" data-a="practice">Proberunde gegen Bots spielen</button>`, {id:'howto'});
}

/* ---------- Aktionen ---------- */
const ACT = {
  tab: el => { APP.tab = el.dataset.tab; if (APP.tab !== 'groups') {} closeModal(true); render(); },
  closeModal: () => { APP.shopPick = null; closeModal(); },
  create: async () => {
    await ensureName();
    APP.create = {step:1, mode:'classic', name:'', settings:sanitizeSettings(defaultSettings('classic'), 'classic')};
    openModal('', {full:true, id:'create'}); renderCreate();
  },
  createMode: el => {
    const m = el.dataset.mode; APP.create.mode = m;
    APP.create.settings = sanitizeSettings(Object.assign(defaultSettings(m), {zones:APP.create.settings.zones, adminPlays:APP.create.settings.adminPlays}), m);
    APP.create.step = 2; renderCreate(); $('#modalBody').scrollTop = 0;
  },
  createBack: () => { APP.create.step = 1; renderCreate(); },
  createGo: async () => {
    const C = APP.create, name = (C.name || '').trim();
    if (name.length < 2){ await confirmBox('Gruppenname erforderlich', 'Gib mindestens 2 Zeichen ein.', 'OK', null); return; }
    const code = genCode();
    GROUPS[code] = {code, name:name.slice(0, 30), mode:C.mode, admin:ME.id, settings:sanitizeSettings(C.settings, C.mode), rules:'',
      members:{}, chat:[], status:'idle', createdAt:now(), lastOpened:now(), lastResult:null};
    saveGroups(); closeModal(true); APP.create = null;
    APP.tab = 'groups'; APP.groupPage = code;
    await openGroup(code);
    await confirmBox('Gruppe erstellt', `„${name}“ ist bereit. Lade jetzt deine Freunde ein.`, 'OK', null);
    showInvite(code);
  },
  join: async (el, pre) => { await ensureName(); showJoin(typeof pre === 'string' ? pre : ''); },
  joinGo: () => {
    const code = normCode($('#joinCodeInput').value);
    if (!code){ toast('Der Code hat 6 Zeichen, zum Beispiel ABC-123.'); return; }
    closeModal(true);
    APP.tab = 'groups'; APP.groupPage = code;
    openGroup(code, {joinOnly: !GROUPS[code]});
    toast('Verbinde …');
  },
  howto: () => showHowTo(),
  practice: async () => { await ensureName(); closeModal(true); startPractice(); },
  openGroup: el => { const c = el.dataset.code; openGroup(c); render(); },
  openChat: el => { openGroup(el.dataset.code); APP.tab = 'chat'; render(); },
  groupPage: el => { const c = el.dataset.code; APP.groupPage = c; APP.tab = 'groups'; closeModal(true); if (NET.code !== c) openGroup(c); render(); },
  groupBack: () => { APP.groupPage = null; render(); },
  invite: el => showInvite((el && el.dataset.code) || NET.code),
  shareCode: el => shareText(`Spiel mit mir Spurlos! Mein Code: ${el.dataset.code}`, joinLink(el.dataset.code)),
  leaveGroup: async () => {
    if (APP.view && !APP.view.spect && !NET.practice && !(await confirmBox('Spiel verlassen?', 'Du läufst gerade in einem Spiel. Ohne dich wird dein Standort nicht mehr gesendet.', 'Verlassen', 'Bleiben', true))) return;
    if (NET.isHost && H.online.size > 1 && !NET.practice && APP.view && !(await confirmBox('Du bist der Host', 'Wenn du gehst, endet das laufende Spiel für alle.', 'Trotzdem gehen', 'Bleiben', true))) return;
    closeNet(); store.del('sp-last'); APP.groupPage = null; releaseWake(); render();
  },
  removeGroup: async el => {
    const c = el.dataset.code;
    if (!(await confirmBox('Gruppe verlassen?', 'Die Gruppe wird von diesem Gerät entfernt. Mit dem Code kannst du später wieder beitreten.', 'Verlassen', 'Abbrechen', true))) return;
    if (NET.code === c){ closeNet(); store.del('sp-last'); }
    delete GROUPS[c]; saveGroups(); APP.groupPage = null; render();
  },
  start: () => send({t:'start'}),
  pref: el => send({t:'member', patch:{pref:el.dataset.v}}),
  editNick: async () => { const me = APP.group.members[ME.id] || {}; const v = await promptBox('Spitzname in dieser Gruppe', me.nick || '', PROFILE.name); if (v !== null) send({t:'member', patch:{nick:v}}); },
  renameGroup: async () => { const v = await promptBox('Gruppenname', APP.group.name); if (v !== null){ if (v.trim().length < 2) toast('Mindestens 2 Zeichen.'); else send({t:'group', name:v}); } },
  editRules: async () => { const v = await promptBox('Hausregeln', APP.group.rules || '', 'z. B. Keine Fahrräder, nicht in Geschäfte …', true); if (v !== null) send({t:'group', rules:v}); },
  sv: el => applySetting(el.dataset.src, el.dataset.k, parseVal(el.dataset.v)),
  step: el => {
    const src = el.dataset.src, k = el.dataset.k, [a, b, st] = LIMITS[k];
    applySetting(src, k, clamp(getPath(settingsOf(src), k) + Number(el.dataset.d) * st, a, b));
  },
  lastResult: el => {
    const g = (el && el.dataset.code && GROUPS[el.dataset.code]) || APP.group; if (!g || !g.lastResult) return;
    showResult(PROFILE.history.find(h => h.id === g.lastResult.id) || g.lastResult);
  },
  openHistory: el => { const r = PROFILE.history.find(h => h.id === el.dataset.id); if (r) showResult(r); },
  replay: () => startReplay(APP.currentResult),
  rpToggle: () => { const R = APP.replay; if (R.t >= R.t1) R.t = R.t0; R.playing = !R.playing; renderHud(); },
  rpClose: () => { APP.replay = null; clearInterval(replayTimer); render(); if (APP.view && APP.view.zone) fitCircle(APP.view.zone.center, APP.view.zone.radius); },
  shareCard: () => shareCard(),
  shareResult: () => { const r = APP.currentResult; if (r) shareText(`🏆 ${r.title} – ${r.subtitle}\n${r.groupName} · ${MODES[r.mode].name} · ${mmss(r.endedAt - r.startedAt)}\n#Spurlos`); },
  centerMe: () => { if (APP.myPos) map.setView([APP.myPos.lat, APP.myPos.lng], Math.max(map.getZoom(), 16)); else toast('Noch kein Standort.'); },
  endGame: async () => {
    if (NET.practice && !(APP.view && APP.view.admin)) { closeNet(); render(); return; }
    if (await confirmBox('Spiel beenden?', 'Das Spiel wird für alle sofort beendet.', 'Beenden', 'Abbrechen', true)) send({t:'end'});
  },
  catch: el => send({t:'catch', target:el.dataset.id}),
  selfCaught: async () => {
    const ctf = APP.view && APP.view.mode === 'ctf';
    if (await confirmBox(ctf ? 'Wurdest du getaggt?' : 'Wurdest du gefangen?', ctf ? 'Du musst danach zurück zu deiner Flagge.' : 'Das kann man nicht rückgängig machen.', 'Ja', 'Nein', true)) send({t:'selfCaught'});
  },
  shop: () => { APP.shopPick = null; openModal('', {id:'shop'}); renderLiveModal(); },
  shopBack: () => { APP.shopPick = null; renderLiveModal(); },
  buy: el => {
    const k = el.dataset.item;
    if (ITEMS[k].target){ APP.shopPick = {item:k, kind:'buy'}; renderLiveModal(); return; }
    send({t:'buy', item:k});
  },
  pickTarget: el => { const P = APP.shopPick; APP.shopPick = null; send({t:P.kind, item:P.item, target:el.dataset.id}); renderLiveModal(); },
  useRevive: () => send({t:'use', item:'revive'}),
  useReboot: () => { APP.shopPick = {item:'reboot', kind:'use'}; if (modalId() !== 'shop') openModal('', {id:'shop'}); renderLiveModal(); },
  questions: () => { openModal('', {id:'questions'}); renderLiveModal(); },
  ask: el => send({t:'ask', q:{type:el.dataset.type, r:Number(el.dataset.r) || 0}}),
  players: () => { openModal('', {id:'players'}); renderLiveModal(); },
  /* Zonen-Editor */
  zoneEdit: () => {
    if (!APP.group || APP.group.admin !== ME.id) return;
    const z = APP.group.settings.zones, c = map.getCenter();
    const center = z.center || APP.myPos || {lat:c.lat, lng:c.lng};
    APP.zoneEdit = {center:{...center}, radius:z.radius, safeZones:structuredClone(z.safeZones), safeR:60};
    APP.tab = 'game'; closeModal(true);
    fitCircle(center, z.radius, 20);
    render();
  },
  zeCenterMap: () => { const c = map.getCenter(); APP.zoneEdit.center = {lat:c.lat, lng:c.lng}; drawMap(); },
  zeCenterMe: () => { if (!APP.myPos) return toast('Noch kein Standort.'); APP.zoneEdit.center = {...APP.myPos}; map.setView([APP.myPos.lat, APP.myPos.lng]); drawMap(); },
  zeSafeR: el => { APP.zoneEdit.safeR = clamp(APP.zoneEdit.safeR + Number(el.dataset.d) * 20, 20, 500); renderHud(); },
  zeAddSafe: () => { const c = map.getCenter(); APP.zoneEdit.safeZones.push({lat:c.lat, lng:c.lng, r:APP.zoneEdit.safeR}); renderHud(); drawMap(); },
  zeDelSafe: el => { APP.zoneEdit.safeZones.splice(Number(el.dataset.i), 1); renderHud(); drawMap(); },
  zeCancel: () => { APP.zoneEdit = null; render(); },
  zeSave: () => {
    const Z = APP.zoneEdit;
    send({t:'settings', patch:{zones:{center:Z.center, radius:Z.radius, safeZones:Z.safeZones, enabled:true}}});
    APP.zoneEdit = null; toast('Zonen gespeichert.'); render();
  },
  /* Persönliche Schutzzone */
  personalEdit: () => {
    if (!APP.group) return;
    const me = APP.group.members[ME.id] || {}, max = APP.group.settings.zones.personalMax, c = map.getCenter();
    const base = me.personalZone || Object.assign({}, APP.myPos || {lat:c.lat, lng:c.lng}, {r:Math.min(100, max)});
    APP.personalEdit = {lat:base.lat, lng:base.lng, r:Math.min(base.r, max)};
    APP.tab = 'game'; closeModal(true);
    map.setView([base.lat, base.lng], 17); render();
  },
  peHere: () => { const c = map.getCenter(); Object.assign(APP.personalEdit, {lat:c.lat, lng:c.lng}); drawMap(); },
  peMe: () => { if (!APP.myPos) return toast('Noch kein Standort.'); Object.assign(APP.personalEdit, APP.myPos); map.setView([APP.myPos.lat, APP.myPos.lng]); drawMap(); },
  peRemove: () => { send({t:'member', patch:{personalZone:null}}); APP.personalEdit = null; toast('Schutzzone entfernt.'); render(); },
  peCancel: () => { APP.personalEdit = null; render(); },
  peSave: () => { send({t:'member', patch:{personalZone:APP.personalEdit}}); APP.personalEdit = null; toast('Schutzzone gespeichert.'); render(); },
  /* Chat & Fotos */
  chatSend: () => { const i = $('#chatText'); if (!i) return; const t = i.value.trim(); if (!t) return; send({t:'chat', text:t}); i.value = ''; i.focus(); },
  chatPhoto: async () => {
    const f = await pickImage(false); if (!f) return;
    try { send({t:'chat', img:await compressImage(f, 900, .65)}); } catch(e){ toast('Das Foto konnte nicht geladen werden.'); }
  },
  viewImg: el => openModal(sheetHead('Foto') + `<img src="${esc(el.getAttribute('src'))}" style="width:100%;border-radius:14px" alt="">`, {id:'img'}),
  takePhoto: () => addPhoto(true),
  pickPhoto: () => addPhoto(false),
  viewPhoto: el => viewPhoto(el.dataset.id),
  sendPhoto: el => { const p = PROFILE.photos.find(x => x.id === el.dataset.id); if (p){ send({t:'chat', img:p.data}); closeModal(); toast('Foto gesendet.'); } },
  delPhoto: async el => {
    if (!(await confirmBox('Foto löschen?', 'Das kann man nicht rückgängig machen.', 'Löschen', 'Abbrechen', true))) return;
    PROFILE.photos = PROFILE.photos.filter(x => x.id !== el.dataset.id); saveProfile(); closeModal(); render();
  },
  /* Profil */
  ptab: el => { APP.profileTab = el.dataset.v; render(); },
  editProfile: () => {
    openModal(sheetHead('Profil bearbeiten') + `<div style="text-align:center"><span id="epAv">${avatar(PROFILE.name, PROFILE.photo, 96)}</span><br>
      <button class="link" data-a="epPhoto" style="margin-top:8px">Foto ändern</button>${PROFILE.photo ? ' · <button class="link" data-a="epNoPhoto">Entfernen</button>' : ''}</div>
      <div class="gap"></div><input id="epName" maxlength="20" value="${esc(PROFILE.name)}" placeholder="Dein Name"><div class="gap"></div>
      <button class="btn primary" data-a="epSave">Speichern</button>`, {id:'profile'});
  },
  epPhoto: async () => {
    const f = await pickImage(false); if (!f) return;
    try {
      PROFILE._newPhoto = await compressImage(f, 256, .8); PROFILE._newAvatar = await compressImage(f, 72, .7);
      $('#epAv').innerHTML = avatar(PROFILE.name, PROFILE._newPhoto, 96);
    } catch(e){ toast('Das Foto konnte nicht geladen werden.'); }
  },
  epNoPhoto: () => { PROFILE._newPhoto = ''; PROFILE._newAvatar = ''; $('#epAv').innerHTML = avatar(PROFILE.name, null, 96); },
  epSave: () => {
    const n = $('#epName').value.trim();
    if (n.length < 2) return toast('Bitte gib mindestens 2 Zeichen ein.');
    PROFILE.name = n;
    if (PROFILE._newPhoto !== undefined){ PROFILE.photo = PROFILE._newPhoto || null; PROFILE.avatar = PROFILE._newAvatar || null; }
    delete PROFILE._newPhoto; delete PROFILE._newAvatar;
    saveProfile(); closeModal(true);
    if (NET.status === 'online' && !NET.practice){
      if (NET.isHost){ upsertMember(ME.id, myMember()); hostBroadcastGroup(); } else if (NET.conn) NET.conn.send({t:'hello', member:myMember()});
    }
    render();
  },
  resetAll: async () => {
    if (!(await confirmBox('Alle Daten löschen?', 'Profil, Gruppen, Fotos und Spielverlauf werden von diesem Gerät gelöscht. Das kann man nicht rückgängig machen.', 'Alles löschen', 'Abbrechen', true))) return;
    closeNet(); for (const k of ['sp-profile', 'sp-groups', 'sp-last']) store.del(k); location.reload();
  }
};
const INPUT = {
  cName: el => { APP.create.name = el.value; },
  zeRange: el => { APP.zoneEdit.radius = Number(el.value); $('#zeRadLabel').textContent = el.value + ' m Radius'; drawMap(); },
  peRange: el => { APP.personalEdit.r = Number(el.value); $('#peLabel').textContent = el.value + ' m'; drawMap(); },
  rpRange: el => { const R = APP.replay; R.t = R.t0 + (R.t1 - R.t0) * Number(el.value) / 1000; R.playing = false; drawMap(); tickClocks(); }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const f = ACT[el.dataset.a];
  if (f){ e.preventDefault(); f(el, e); }
});
document.addEventListener('input', e => { const el = e.target; if (el.dataset && INPUT[el.dataset.in]) INPUT[el.dataset.in](el); });
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.tg) applySetting(el.dataset.src, el.dataset.tg, el.checked);
  else if (el.dataset.in === 'startAt'){ const t = new Date(el.value).getTime(); if (t > now()) applySetting(el.dataset.src, 'startAt', t); else toast('Die Startzeit muss in der Zukunft liegen.'); }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'chatText'){ e.preventDefault(); ACT.chatSend(); }
  if (e.target.id === 'joinCodeInput'){ e.preventDefault(); ACT.joinGo(); }
});
document.addEventListener('focusout', () => setTimeout(() => { if (APP.pendingRender && !pageHasFocus('#pg-groups')){ APP.pendingRender = false; render(); } }, 60));
window.addEventListener('beforeunload', e => { if (NET.isHost && !NET.practice && H.online.size > 1){ e.preventDefault(); e.returnValue = ''; } });

/* ---------- Als App installieren ---------- */
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; render(); });
window.addEventListener('appinstalled', () => { installPrompt = null; toast('📲 Spurlos ist jetzt auf deinem Home-Bildschirm!'); render(); });
const installLink = () => isStandalone() ? '' : '<button class="link" data-a="install">📲 App installieren</button>';
ACT.install = async () => {
  if (installPrompt){ installPrompt.prompt(); try { await installPrompt.userChoice; } catch(e){} installPrompt = null; render(); return; }
  const steps = isIOS()
    ? `<li>Öffne diese Seite in <b>Safari</b>.</li><li>Tippe unten auf das <b>Teilen-Symbol</b> (Quadrat mit Pfeil nach oben).</li><li>Wähle <b>„Zum Home-Bildschirm“</b> und tippe auf <b>Hinzufügen</b>.</li>`
    : `<li>Öffne diese Seite in <b>Chrome</b>.</li><li>Tippe oben rechts auf <b>⋮</b>.</li><li>Wähle <b>„App installieren“</b> oder <b>„Zum Startbildschirm hinzufügen“</b>.</li>`;
  openModal(sheetHead('📲 App installieren') + `<div style="text-align:center"><img src="icons/icon-192.png" width="96" height="96" style="border-radius:22px" alt=""></div>
    <p class="muted">So hast du Spurlos mit eigenem Icon auf dem Home-Bildschirm. Es öffnet sich dann im Vollbild wie eine normale App.</p>
    <ol style="line-height:1.9;padding-left:20px">${steps}</ol>`, {id:'install'});
};

/* ---------- Start ---------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (TEST) document.body.insertAdjacentHTML('beforeend', '<div class="testbadge">TESTMODUS · Karte antippen = bewegen</div>');
startGPS();
render();
ensureName().then(() => {
  const j = normCode(QS.get('join'));
  if (j){ history.replaceState(null, '', location.pathname + (TEST ? '?test' : '')); if (GROUPS[j]){ APP.tab = 'groups'; APP.groupPage = j; openGroup(j); } else ACT.join(null, j); }
  else { const last = store.get('sp-last', null); if (last && GROUPS[last]) openGroup(last); }
});
