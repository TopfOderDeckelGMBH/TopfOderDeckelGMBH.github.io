"use strict";
/* ===== Hilfsfunktionen, Speicher, Profil ===== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SEC = 1000, MIN = 60000;
const QS = new URLSearchParams(location.search);
const TEST = QS.has('test');
const PREFIX = 'spurlos-v2-';
const now = () => Date.now();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad = n => String(n).padStart(2, '0');

function uid(n = 10){
  const a = 'abcdefghijkmnpqrstuvwxyz23456789', r = crypto.getRandomValues(new Uint8Array(n));
  return [...r].map(x => a[x % a.length]).join('');
}
function genCode(){
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', r = crypto.getRandomValues(new Uint8Array(6));
  const s = [...r].map(x => A[x % 32]).join('');
  return s.slice(0,3) + '-' + s.slice(3);
}
function normCode(c){
  c = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 6 ? c.slice(0,3) + '-' + c.slice(3) : null;
}
function shuffle(a){ for (let i = a.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function mmss(ms){
  ms = Math.max(0, ms); const s = Math.floor(ms / 1000), h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
const fmtKm = m => (m / 1000).toFixed(1).replace('.', ',');
const fmtDist = m => m >= 1000 ? fmtKm(m) + ' km' : Math.round(m) + ' m';
const fmtDate = t => new Date(t).toLocaleString('de-DE', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'});
const fmtMonth = t => new Date(t).toLocaleString('de-DE', {month:'long', year:'numeric'});
const fmtTime = t => new Date(t).toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit'});

function dist(a, b){
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function movePos(p, bearing, m){
  const lat = p.lat + m * Math.cos(bearing) / 111320;
  return {lat, lng: p.lng + m * Math.sin(bearing) / (111320 * Math.cos(lat * Math.PI / 180))};
}
function bearingTo(a, b){
  return Math.atan2((b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180), b.lat - a.lat);
}
const lerpPos = (a, b, t) => ({lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t});
const validPos = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

// ?test&as=2 gibt einem Test-Tab eine eigene Identität (sonst teilen sich Tabs denselben Speicher)
const NS = TEST && QS.get('as') ? '-' + QS.get('as').replace(/[^\w]/g, '') : '';
const store = {
  get(k, d){ try { const v = localStorage.getItem(k + NS); return v == null ? d : JSON.parse(v); } catch(e){ return d; } },
  set(k, v){ try { localStorage.setItem(k + NS, JSON.stringify(v)); return true; } catch(e){ return false; } },
  del(k){ try { localStorage.removeItem(k + NS); } catch(e){} }
};

/* ===== Ich, Profil, Gruppen ===== */
const ME = {id: store.get('sp-id', null)};
if (!ME.id){ ME.id = uid(12); store.set('sp-id', ME.id); }

const PROFILE = Object.assign({
  name:'', photo:null, avatar:null,
  stats:{games:0, wins:0, catches:0, distance:0, time:0, hunterWins:0, hiderWins:0, longestSurvival:0},
  history:[], photos:[]
}, store.get('sp-profile', {}));
function saveProfile(){
  if (store.set('sp-profile', PROFILE)) return;
  PROFILE.photos = PROFILE.photos.slice(-10);
  for (const h of PROFILE.history.slice(0, -5)) for (const p of h.players || []) p.track = [];
  if (!store.set('sp-profile', PROFILE)) toast('Speicher voll – ältere Daten wurden gekürzt.');
}

let GROUPS = store.get('sp-groups', {});
function saveGroups(){
  if (store.set('sp-groups', GROUPS)) return;
  for (const g of Object.values(GROUPS)) g.chat = (g.chat || []).slice(-60).map(m => ({...m, img:null}));
  store.set('sp-groups', GROUPS);
}

/* ===== Spielmodi & Einstellungen ===== */
const MODES = {
  classic:  {name:'Klassisch',        emo:'🏃', short:'Sucher jagen Versteckte im echten Leben.'},
  fugitive: {name:'Flüchtiger',       emo:'🦊', short:'Einer flieht, alle anderen jagen ihn.'},
  assassin: {name:'Auftragsjagd',     emo:'🗡️', short:'Jeder jagt ein zugeteiltes Ziel.'},
  questions:{name:'Fragen',           emo:'❓', short:'Keine Pings: Sucher stellen Fragen, GPS antwortet.'},
  ctf:      {name:'Capture the Flag', emo:'🚩', short:'Zwei Teams, zwei Flaggen. Hol die andere!'}
};
const HOW_TO_WIN = {
  classic:  [['hider','Versteckter','Bleib frei, bis die Zeit abläuft.'], ['hunter','Sucher','Fang alle Versteckten, bevor die Zeit abläuft.']],
  fugitive: [['hider','Flüchtiger','Bleib bis zum Ende frei.'], ['hunter','Jäger','Fangt den Flüchtigen gemeinsam.']],
  assassin: [['assassin','Alle','Fang dein Ziel und übernimm dessen Ziel. Wer als Letzter übrig ist, gewinnt. Läuft die Zeit ab, gewinnt, wer die meisten Fänge hat.']],
  questions:[['hider','Versteckter','Bleib frei, bis die Zeit abläuft. Die App beantwortet die Fragen der Sucher automatisch.'], ['hunter','Sucher','Stell Fragen (Radar, Richtung, Wärmer/Kälter) und fang alle Versteckten.']],
  ctf:      [['red','Beide Teams','Klau die gegnerische Flagge und bring sie zu deiner eigenen. Wer im gegnerischen Gebiet getaggt wird, muss zurück zur eigenen Flagge.']]
};
function defaultSettings(mode){
  return {
    seekerMode: mode === 'ctf' ? 'random' : 'random', seekerCount:1, onCaught:'out',
    duration: mode === 'ctf' ? 30 : 45, headStart:5, pingEvery:5, pingWho:'hider', pingFaster:false, pingAnon:false,
    questionCooldown:3, scoreToWin:3, abilities:true, adminPlays:true, startAt:null,
    zones:{enabled:true, center:null, radius:500, safeZonesAllowed:true, safeZones:[], shrinking:false, wandering:false, personal:true, personalMax:200}
  };
}
const LIMITS = {seekerCount:[1,10,1], duration:[5,240,5], headStart:[0,30,1], pingEvery:[1,30,1], questionCooldown:[1,15,1], scoreToWin:[1,10,1], 'zones.radius':[100,5000,50], 'zones.personalMax':[50,500,50]};
function sanitizeSettings(s, mode){
  const d = defaultSettings(mode), o = Object.assign({}, d, s || {});
  o.zones = Object.assign({}, d.zones, (s && s.zones) || {});
  for (const k in LIMITS){
    const [a, b] = LIMITS[k];
    if (k.startsWith('zones.')){ const kk = k.slice(6); o.zones[kk] = clamp(Number(o.zones[kk]) || a, a, b); }
    else o[k] = clamp(Number(o[k]) || a, a, b);
  }
  if (!['random','creator','choose'].includes(o.seekerMode)) o.seekerMode = 'random';
  if (!['out','seeker'].includes(o.onCaught)) o.onCaught = 'out';
  if (!['hider','hunter','both'].includes(o.pingWho)) o.pingWho = 'hider';
  for (const k of ['pingFaster','pingAnon','abilities','adminPlays']) o[k] = !!o[k];
  for (const k of ['enabled','safeZonesAllowed','shrinking','wandering','personal']) o.zones[k] = !!o.zones[k];
  o.zones.center = validPos(o.zones.center) ? {lat:+o.zones.center.lat, lng:+o.zones.center.lng} : null;
  o.zones.safeZones = (Array.isArray(o.zones.safeZones) ? o.zones.safeZones : []).filter(validPos).slice(0, 20)
    .map(z => ({lat:+z.lat, lng:+z.lng, r:clamp(+z.r || 60, 20, 500)}));
  o.startAt = Number.isFinite(o.startAt) && o.startAt > now() ? o.startAt : null;
  return o;
}

const ITEMS = {
  cloak:      {name:'Tarnkappe',            emo:'🫥', cost:2, side:'hider',  desc:'10 Minuten lang tauchst du bei keinem Ping auf.'},
  immunity:   {name:'Immunität',            emo:'🛡️', cost:1, side:'hider',  desc:'Blockt 10 Minuten lang jeden Fang.'},
  bounty:     {name:'Kopfgeld',             emo:'💰', cost:2, side:'hunter', target:true, desc:'Setz 15 Minuten lang ein Kopfgeld auf einen Gegner: Sein Standort erscheint jede Minute. Fang ihn für +3 Punkte.'},
  clearBounty:{name:'Kopfgeld löschen',     emo:'🧽', cost:1, side:'hider',  desc:'Entfernt ein Kopfgeld, das auf dich ausgesetzt ist.'},
  revive:     {name:'Wiederbeleben',        emo:'❤️', cost:3, side:'any', inventory:true, desc:'Kauf vorab und nutze es, nachdem du gefangen wurdest: Du bist wieder im Spiel.'},
  reboot:     {name:'Reboot-Karte',         emo:'🔁', cost:3, side:'any', inventory:true, desc:'Hol einen gefangenen Mitspieler aus deinem Team zurück ins Spiel.'},
  extraZone:  {name:'Extra-Schutzzone',     emo:'⭕', cost:1, side:'hider',  desc:'Erstellt an deinem Standort eine Schutzzone (50 m) für den Rest des Spiels. Nur für dich.'},
  disableZone:{name:'Schutzzone deaktivieren', emo:'🚫', cost:1, side:'any', target:true, desc:'Schaltet die persönlichen Schutzzonen eines Gegners 10 Minuten lang aus.'},
  steal:      {name:'Punkte klauen',        emo:'🦝', cost:1, side:'any', target:true, desc:'Nimmt einem Gegner 1 verfügbaren Fähigkeitspunkt ab.'}
};
const ROLE_LABEL = {hunter:'Sucher', hider:'Versteckter', assassin:'Jäger', red:'Team Rot', blue:'Team Blau'};
const ROLE_ICON = {hunter:'🎯', hider:'🫥', assassin:'🗡️', red:'🔴', blue:'🔵'};
function roleLabel(role, mode){
  if (mode === 'fugitive') return role === 'hider' ? 'Flüchtiger' : 'Jäger';
  return ROLE_LABEL[role] || role;
}

/* ===== Oberfläche: Toast, Dialoge, Avatare, Bilder ===== */
let toastTimer;
function toast(msg, ms = 3200){
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function vibrate(p){ try { navigator.vibrate && navigator.vibrate(p); } catch(e){} }

function colorFor(s){ let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 75% 62%)`; }
function avatar(name, img, size = 40){
  const st = `width:${size}px;height:${size}px;font-size:${Math.round(size * .42)}px;`;
  if (img) return `<span class="avatar" style="${st}background-image:url('${esc(img)}')"></span>`;
  const ini = String(name || '?').trim().slice(0, 1).toUpperCase() || '?';
  return `<span class="avatar" style="${st}background:${colorFor(name)}">${esc(ini)}</span>`;
}

function compressImage(file, max = 900, q = .72){
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', q));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Bild konnte nicht geladen werden')); };
    img.src = url;
  });
}
function pickImage(capture = true){
  return new Promise(res => {
    const inp = $('#fileInput');
    if (capture) inp.setAttribute('capture', 'environment'); else inp.removeAttribute('capture');
    inp.value = ''; inp.onchange = () => res(inp.files[0] || null); inp.click();
  });
}

/* Modals */
let modalClose = null;
function openModal(html, {full = false, center = false, onClose = null, id = '', locked = false} = {}){
  closeModal(true);
  const back = document.createElement('div');
  back.className = 'modal-back' + (center ? ' center' : '');
  back.innerHTML = center ? `<div class="dialog" id="modalBody">${html}</div>` : `<div class="sheet${full ? ' full' : ''}" id="modalBody">${html}</div>`;
  back.dataset.id = id;
  back.addEventListener('click', e => { if (e.target === back && !full && !locked) closeModal(); });
  $('#modalRoot').appendChild(back);
  modalClose = onClose;
  return back;
}
function closeModal(silent){
  const r = $('#modalRoot'); if (!r.firstChild) return;
  r.innerHTML = '';
  const f = modalClose; modalClose = null;
  if (f && !silent) f();
}
const modalId = () => { const m = $('#modalRoot .modal-back'); return m ? m.dataset.id : null; };
function confirmBox(title, text, ok = 'OK', cancel = 'Abbrechen', danger = false){
  return new Promise(res => {
    const prev = $('#modalRoot').firstChild; if (prev) prev.style.display = 'none';
    const back = document.createElement('div'); back.className = 'modal-back center'; back.style.zIndex = 2000;
    back.innerHTML = `<div class="dialog"><h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>
      <div class="row">${cancel ? `<button class="btn" data-r="0">${esc(cancel)}</button>` : ''}<button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div></div>`;
    back.addEventListener('click', e => {
      const b = e.target.closest('[data-r]'); if (!b) return;
      back.remove(); if (prev) prev.style.display = ''; res(b.dataset.r === '1');
    });
    document.body.appendChild(back);
  });
}
function promptBox(title, value = '', placeholder = '', multiline = false){
  return new Promise(res => {
    const back = document.createElement('div'); back.className = 'modal-back center'; back.style.zIndex = 2000;
    back.innerHTML = `<div class="dialog"><h3>${esc(title)}</h3><div class="gap"></div>
      ${multiline ? `<textarea id="pb" placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input id="pb" value="${esc(value)}" placeholder="${esc(placeholder)}">`}
      <div class="gap"></div><div class="row"><button class="btn" data-r="0">Abbrechen</button><button class="btn primary" data-r="1">Speichern</button></div></div>`;
    back.addEventListener('click', e => {
      const b = e.target.closest('[data-r]'); if (!b) return;
      const v = $('#pb', back).value; back.remove(); res(b.dataset.r === '1' ? v : null);
    });
    document.body.appendChild(back);
    setTimeout(() => $('#pb', back).focus(), 50);
  });
}
/* setzt innerHTML nur, wenn sich etwas geändert hat (verhindert Flackern und verlorene Klicks) */
function setHTML(el, html){ if (el && el._h !== html){ el.innerHTML = html; el._h = html; return true; } return false; }
