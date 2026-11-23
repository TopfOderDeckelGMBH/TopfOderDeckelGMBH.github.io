"use strict";
/* ===== Verbindung: Wer eine Gruppe zuerst öffnet, wird ihr Host. Alle anderen verbinden sich mit ihm. ===== */
const NET = {peer:null, conn:null, isHost:false, code:null, status:'off', practice:false, retry:0, retryTimer:null};
const PEER_OPTS = {debug:0};
const peerId = code => PREFIX + code.replace('-', '');

function closeNet(){
  clearTimeout(NET.retryTimer);
  if (NET.isHost) hostStop();
  try { NET.conn && NET.conn.close(); } catch(e){}
  try { NET.peer && NET.peer.destroy(); } catch(e){}
  Object.assign(NET, {peer:null, conn:null, isHost:false, code:null, status:'off', practice:false});
  APP.group = null; APP.online = []; APP.gameInfo = null; APP.view = null;
}

async function openGroup(code, {joinOnly = false} = {}){
  if (NET.code === code && (NET.status === 'online' || NET.status === 'connecting')) return;
  closeNet();
  NET.code = code; NET.status = 'connecting';
  store.set('sp-last', code);
  render();
  if (!joinOnly && GROUPS[code]){
    if (await tryHost(code)) return;
    if (NET.code !== code) return;
  }
  connectClient(code, joinOnly);
}

function tryHost(code){
  return new Promise(res => {
    let done = false;
    const p = new Peer(peerId(code), PEER_OPTS);
    const finish = ok => { if (done) return; done = true; if (!ok) try { p.destroy(); } catch(e){} res(ok); };
    p.on('open', () => {
      if (done || NET.code !== code){ try { p.destroy(); } catch(e){} return; }
      done = true;
      NET.peer = p; NET.isHost = true; NET.status = 'online'; NET.retry = 0;
      hostInit(GROUPS[code]);
      p.on('connection', c => hostAccept(c));
      res(true);
    });
    p.on('disconnected', () => { if (done && NET.peer === p) try { p.reconnect(); } catch(e){} });
    p.on('error', e => {
      if (!done) return finish(false);
      if (e.type === 'network' || e.type === 'server-error') toast('Verbindungsproblem … versuche weiter.');
    });
    setTimeout(() => finish(false), 9000);
  });
}

function connectClient(code, joinOnly){
  const p = new Peer(PEER_OPTS);
  NET.peer = p; NET.isHost = false;
  p.on('open', () => {
    if (NET.peer !== p) return;
    const c = p.connect(peerId(code), {reliable:true});
    NET.conn = c;
    c.on('open', () => { NET.status = 'online'; NET.retry = 0; c.send({t:'hello', member:myMember()}); render(); });
    c.on('data', m => { if (NET.conn === c) recv(m); });
    c.on('close', () => {
      if (NET.conn !== c) return;
      NET.status = 'lost'; toast('Verbindung zur Gruppe verloren … verbinde neu.'); render();
      scheduleReconnect(code);
    });
  });
  p.on('error', e => {
    if (NET.peer !== p) return;
    if (e.type === 'peer-unavailable'){
      if (GROUPS[code] && !joinOnly){ scheduleReconnect(code); return; }
      if (GROUPS[code]){ // bekannte Gruppe, aber gerade niemand online -> selbst hosten
        NET.code = null; openGroup(code); return;
      }
      toast('Niemand aus dieser Gruppe ist gerade online. Prüfe den Code oder bitte jemanden aus der Gruppe, die App zu öffnen.', 6000);
      closeNet(); store.del('sp-last'); render();
    } else {
      toast('Verbindung fehlgeschlagen. Bist du online?');
      scheduleReconnect(code);
    }
  });
}
function scheduleReconnect(code){
  clearTimeout(NET.retryTimer);
  if (NET.retry > 6){ NET.status = 'off'; render(); return; }
  NET.retry++;
  NET.retryTimer = setTimeout(() => { if (NET.code === code){ NET.code = null; openGroup(code); } }, 1500 + NET.retry * 1000);
}

function send(msg){
  if (NET.isHost){ if (H.group) hostHandle(ME.id, msg); }
  else if (NET.conn && NET.conn.open) NET.conn.send(msg);
  else toast('Nicht verbunden.');
}

/* Proberunde gegen Bots, komplett offline */
function startPractice(){
  closeNet();
  const c = map.getCenter();
  const center = APP.myPos || {lat:c.lat, lng:c.lng};
  if (!APP.myPos) setPos(center.lat, center.lng, true);
  const settings = sanitizeSettings(Object.assign(defaultSettings('classic'), {
    duration:10, headStart:1, pingEvery:1, seekerMode:'choose',
    zones:Object.assign(defaultSettings('classic').zones, {center, radius:300})
  }), 'classic');
  const g = {code:'PRAXIS', name:'Proberunde', mode:'classic', admin:ME.id, settings, practice:true,
    rules:'Proberunde gegen Bots. Tippe auf die Karte, um dich zu bewegen.', members:{}, chat:[], status:'idle'};
  NET.practice = true; NET.isHost = true; NET.code = 'PRAXIS'; NET.status = 'online';
  hostInit(g);
  const bots = [['bot-1','Bot Anna','hunter'], ['bot-2','Bot Ben','hider'], ['bot-3','Bot Cem','hider']];
  for (const [id, name, pref] of bots){
    upsertMember(id, {id, name, bot:true}); H.group.members[id].pref = pref; H.online.add(id);
    H.pos[id] = Object.assign(movePos(center, Math.random() * 6.28, 60 + Math.random() * 180), {t:now()});
  }
  H.group.members[ME.id].pref = 'hider';
  H.pos[ME.id] = {lat:APP.myPos.lat, lng:APP.myPos.lng, t:now()};
  APP.tab = 'game'; APP.groupPage = null;
  startGame(ME.id);
  toast('Proberunde: Tippe auf die Karte, um dich zu bewegen. Bot Anna sucht dich!', 5000);
}
