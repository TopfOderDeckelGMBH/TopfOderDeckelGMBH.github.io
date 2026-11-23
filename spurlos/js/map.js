"use strict";
/* ===== Karte ===== */
const map = L.map('map', {zoomControl:false, worldCopyJump:true}).setView([30, 10], 2);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution:'&copy; OpenStreetMap', maxZoom:19, className:'dark-tiles'}).addTo(map);
const zoneL = L.layerGroup().addTo(map), markL = L.layerGroup().addTo(map);

function pin(pos, cls, label){
  return L.marker([pos.lat, pos.lng], {interactive:false, icon:L.divIcon({className:'', iconSize:[0, 0],
    html:`<div class="pin ${cls}">${label ? `<span>${esc(label)}</span>` : ''}</div>`})});
}
function flagMarker(pos, emoji){
  return L.marker([pos.lat, pos.lng], {interactive:false, icon:L.divIcon({className:'', iconSize:[0, 0], html:`<div class="flag">${emoji}</div>`})});
}
const circle = (c, r, o) => L.circle([c.lat, c.lng], Object.assign({radius:r, interactive:false}, o));
const ZONE_STYLE = {color:'#b6f23a', weight:2, fillColor:'#b6f23a', fillOpacity:.05, dashArray:'6 6'};
const SAFE_STYLE = {color:'#3ad1f2', weight:2, fillColor:'#3ad1f2', fillOpacity:.15};

function drawMap(){
  zoneL.clearLayers(); markL.clearLayers();
  if (APP.replay) return drawReplay();
  const v = APP.view, sn = syncedNow();
  if (v){
    if (v.zone){
      if (Math.abs(v.zone.radius - v.zone.r0) > 1 || dist(v.zone.center, v.zone.c0) > 1)
        circle(v.zone.c0, v.zone.r0, {color:'#8b98a8', weight:1, fill:false, dashArray:'3 6'}).addTo(zoneL);
      circle(v.zone.center, v.zone.radius, ZONE_STYLE).addTo(zoneL);
    }
    for (const z of v.safeZones) circle(z, z.r, SAFE_STYLE).addTo(zoneL);
    for (const z of v.myZones) circle(z, z.r, Object.assign({}, SAFE_STYLE, {dashArray:'4 4'})).addTo(zoneL);
    if (v.flags){
      flagMarker(v.flags.red.pos, '🟥').addTo(markL); flagMarker(v.flags.blue.pos, '🟦').addTo(markL);
      if (!v.flags.red.carrier) circle(v.flags.red.pos, FLAG_R, {color:'#ff5a4e', weight:1, fillOpacity:.15}).addTo(zoneL);
      if (!v.flags.blue.carrier) circle(v.flags.blue.pos, FLAG_R, {color:'#4e8bff', weight:1, fillOpacity:.15}).addTo(zoneL);
    }
    if (v.my && v.my.role === 'hunter') for (const q of v.questions.filter(q => q.type === 'radar').slice(-3)){
      const yes = q.answers.some(a => a.answer.startsWith('Ja'));
      circle(q.pos, q.r, {color: yes ? '#ffc83d' : '#666', weight:1, fillOpacity: yes ? .08 : .02, dashArray:'2 6'}).addTo(zoneL);
    }
    if (v.ping) for (const p of v.ping.list){
      const ago = Math.max(0, Math.round((sn - v.ping.at) / MIN));
      pin(p.pos, 'ping ' + p.role, `${p.name} · ${ago ? 'vor ' + ago + ' min' : 'jetzt'}`).addTo(markL);
    }
    for (const b of v.bounty){
      const ago = Math.max(0, Math.round((sn - b.at) / MIN));
      pin(b.pos, 'bounty', `${b.name} · ${ago ? 'vor ' + ago + ' min' : 'jetzt'}`).addTo(markL);
    }
    for (const p of v.players){
      if (p.id === v.me || !p.pos) continue;
      const cls = p.caught ? 'caught' : p.role;
      pin(p.pos, cls, p.name + (p.out ? ' ⚠️' : '') + (p.online ? '' : ' (offline)') + (v.flags && (v.flags.red.carrier === p.id || v.flags.blue.carrier === p.id) ? ' 🚩' : '')).addTo(markL);
    }
  } else if (APP.group && NET.status === 'online'){
    const s = APP.group.settings, z = s.zones;
    const editing = APP.zoneEdit ? APP.zoneEdit : null;
    const center = editing ? editing.center : z.center, radius = editing ? editing.radius : z.radius;
    if (z.enabled && center) circle(center, radius, ZONE_STYLE).addTo(zoneL);
    const safes = editing ? editing.safeZones : (z.safeZonesAllowed ? z.safeZones : []);
    for (const sz of safes) circle(sz, sz.r, SAFE_STYLE).addTo(zoneL);
    const me = APP.group.members[ME.id];
    const pz = APP.personalEdit || (z.personal && me && me.personalZone);
    if (pz && pz.lat != null) circle(pz, pz.r, Object.assign({}, SAFE_STYLE, {dashArray:'4 4'})).addTo(zoneL);
    if (editing || APP.personalEdit){
      const c = map.getCenter();
      L.marker(c, {interactive:false, icon:L.divIcon({className:'', iconSize:[0, 0], html:'<div style="transform:translate(-50%,-50%);font-size:26px;color:#b6f23a">✛</div>'})}).addTo(markL);
    }
  }
  if (APP.myPos){
    const my = v && v.my;
    pin(APP.myPos, 'me ' + (my ? (my.caught ? 'caught' : my.role) : 'hider'), 'Du').addTo(markL);
  }
}
map.on('move', () => { if (APP.zoneEdit || APP.personalEdit) drawMap(); });

/* Spielrückblick: Routen aller Spieler abspielen */
function drawReplay(){
  const R = APP.replay, r = R.result;
  if (r.zone) circle(r.zone.center, r.zone.radius, ZONE_STYLE).addTo(zoneL);
  for (const p of r.players){
    const tr = p.track.filter(x => x[2] <= R.t);
    if (!tr.length) continue;
    const col = {hunter:'#ff4d5e', hider:'#3ad1f2', assassin:'#ffc83d', red:'#ff5a4e', blue:'#4e8bff'}[p.initialRole] || '#ccc';
    L.polyline(tr.map(x => [x[0], x[1]]), {color:col, weight:3, opacity:.75, interactive:false}).addTo(zoneL);
    const last = tr[tr.length - 1];
    const gone = p.caughtAt && p.caughtAt <= R.t;
    pin({lat:last[0], lng:last[1]}, gone ? 'caught' : p.initialRole, p.name).addTo(markL);
  }
}
function fitReplay(r){
  const pts = r.players.flatMap(p => p.track.map(x => [x[0], x[1]]));
  if (pts.length) map.fitBounds(L.latLngBounds(pts), {padding:[40, 40]});
  else if (r.zone) fitCircle(r.zone.center, r.zone.radius);
}
function fitCircle(c, r, pad = 30){ map.fitBounds(L.latLng(c.lat, c.lng).toBounds(r * 2), {padding:[pad, pad]}); }

/* Route als Bild (für „Deine Karte“ und zum Teilen) */
function drawRoute(canvas, track, opts = {}){
  const ctx = canvas.getContext('2d'), W = canvas.width, Hh = canvas.height;
  ctx.clearRect(0, 0, W, Hh);
  if (opts.bg){ ctx.fillStyle = opts.bg; ctx.fillRect(0, 0, W, Hh); }
  if (!track || track.length < 2){
    ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = `${Math.round(W / 22)}px system-ui`; ctx.textAlign = 'center';
    ctx.fillText('Keine Route aufgezeichnet', W / 2, Hh / 2); return;
  }
  const lat0 = track[0][0] * Math.PI / 180;
  const xs = track.map(p => p[1] * Math.cos(lat0)), ys = track.map(p => p[0]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = W * .1, k = Math.min((W - 2 * pad) / ((maxX - minX) || 1e-9), (Hh - 2 * pad) / ((maxY - minY) || 1e-9));
  const ox = (W - (maxX - minX) * k) / 2, oy = (Hh - (maxY - minY) * k) / 2;
  const P = i => [ox + (xs[i] - minX) * k, Hh - (oy + (ys[i] - minY) * k)];
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.strokeStyle = opts.color || '#fff'; ctx.lineWidth = Math.max(3, W / 90);
  ctx.beginPath(); track.forEach((_, i) => { const [x, y] = P(i); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  const dot = (i, c) => { const [x, y] = P(i); ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, W / 50, 0, 7); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke(); };
  dot(0, '#b6f23a'); dot(track.length - 1, '#ff4d5e');
}
