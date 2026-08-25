/* ══════════════════════════════════════════════════════
   app.js ─ 館の案内係
   画面の出し入れと、主・客それぞれの振る舞い。
   ══════════════════════════════════════════════════════ */

import { connect, makeCode, normalizeCode, codeToKana } from './net.js';
import {
  createState, addPlayer, refreshPresence, apply, nudgeIfStuck,
  seatedPlayers, presentPlayers, currentId, currentPlayer, arcanaOf,
  MAX_SEATS, KIND_LABEL, KIND_DECO, CAT_LABEL
} from './game.js';

/* ══════════ 小道具 ══════════ */
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => (
  { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
));

const STRATEGY = new URLSearchParams(location.search).get('net') === 'mqtt' ? 'mqtt' : 'nostr';

/* ══════════ 日本語を文節で折る ══════════
   「一番静か／に壊れかけて」のような割れ方をさせない。
   自立語（漢字・カタカナ・英数）で始まる語をひと塊の頭とし、
   後ろに続くひらがな（助詞・助動詞・句読点）はその塊に抱かせる。 */
const SEGMENTER = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('ja', { granularity: 'word' })
  : null;

const HEAD = /[々〇㐀-鿿゠-ヿｦ-ﾟA-Za-z0-9０-９Ａ-Ｚａ-ｚ「『（(【〈]/;

function chunkText(text){
  if (!SEGMENTER) return [text];
  const out = [];
  for (const { segment } of SEGMENTER.segment(text)){
    if (!out.length || HEAD.test(segment[0])) out.push(segment);
    else out[out.length - 1] += segment;
  }
  return out;
}

/** 文節ごとに inline-block で包む。塊が行に入り切らないときだけ、中で折れる。 */
function wrapJa(text){
  return chunkText(text).map(s => `<span class="bs">${esc(s)}</span>`).join('<wbr>');
}

/** 「*ここ*」を強調に変えつつ、全体を文節で折る。 */
function say(text){
  return text.split('*')
    .map((run, i) => (i % 2 ? `<b>${wrapJa(run)}</b>` : wrapJa(run)))
    .join('<wbr>');
}

let net = null;
let state = null;
let myName = '';
let pendingSpicy = true;
let lastTurnOwner = null;
let toastTimer = null;
let seatTimer = null;

const isHost = () => !!(net && state && state.hostId === net.selfId);
const meId   = () => net?.selfId ?? null;

/* ══════════ 画面 ══════════ */
function show(id){
  $$('.screen').forEach(el => el.classList.toggle('is-active', el.id === id));
  window.scrollTo(0, 0);
}

function toast(msg){
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function netbar(state_, detail){
  const el = $('#netbar');
  el.hidden = false;
  document.body.classList.add('with-netbar');
  el.classList.toggle('is-ok',  state_ === 'ok');
  el.classList.toggle('is-bad', state_ === 'error');
  $('#netbar-text').textContent = detail;
}

function buzz(ms){
  try { navigator.vibrate?.(ms); } catch { /* 対応していない端末は静かに無視 */ }
}

/* ══════════ 入口 ══════════ */
if (localStorage.getItem('shinjitsu:gate') === 'ok') show('s-home');

$('#gate-enter').addEventListener('click', () => {
  localStorage.setItem('shinjitsu:gate', 'ok');
  show('s-home');
});

$$('[data-back]').forEach(b => b.addEventListener('click', () => show(b.dataset.back)));

$('#go-create').addEventListener('click', () => {
  $('#create-name').value = localStorage.getItem('shinjitsu:name') || '';
  show('s-create');
  setTimeout(() => $('#create-name').focus(), 60);
});

$('#go-join').addEventListener('click', () => {
  $('#join-name').value = localStorage.getItem('shinjitsu:name') || '';
  show('s-join');
  setTimeout(() => $('#join-code').focus(), 60);
});

/* きわどいお題の切り替え */
const sw = $('#sw-spicy');
sw.addEventListener('click', () => {
  pendingSpicy = !pendingSpicy;
  sw.classList.toggle('is-on', pendingSpicy);
  sw.setAttribute('aria-checked', String(pendingSpicy));
  sw.querySelector('.switch-text').textContent = pendingSpicy ? '入れる' : '抜く';
});

/* 合言葉の入力は打った先から整える */
$('#join-code').addEventListener('input', e => {
  const pos = e.target.selectionStart;
  const before = e.target.value;
  const after = normalizeCode(before);
  if (before !== after){
    e.target.value = after;
    e.target.setSelectionRange(Math.min(pos, after.length), Math.min(pos, after.length));
  }
});

/* ══════════ 部屋をつくる ══════════ */
$('#do-create').addEventListener('click', async () => {
  const name = $('#create-name').value.trim();
  if (!name) return toast('名前を入れてください');
  localStorage.setItem('shinjitsu:name', name);
  myName = name;

  const code = makeCode(6);
  $('#do-create').disabled = true;
  try {
    await openRoom(code, { asHost: true, spicy: pendingSpicy });
  } catch {
    toast('つながりませんでした');
  } finally {
    $('#do-create').disabled = false;
  }
});

/* ══════════ 部屋に入る ══════════ */
$('#do-join').addEventListener('click', async () => {
  const code = normalizeCode($('#join-code').value);
  const name = $('#join-name').value.trim();
  if (code.length !== 6) return toast('合言葉は6文字です');
  if (!name) return toast('名前を入れてください');
  localStorage.setItem('shinjitsu:name', name);
  myName = name;

  $('#do-join').disabled = true;
  try {
    await openRoom(code, { asHost: false });
  } catch {
    toast('つながりませんでした');
  } finally {
    $('#do-join').disabled = false;
  }
});

/* ══════════ 部屋をひらく ══════════ */
async function openRoom(code, { asHost, spicy }){
  net = await connect({
    code,
    strategy: STRATEGY,
    onJoin: onPeerJoin,
    onLeave: onPeerLeave,
    onMessage: onMessage,
    onStatus: s => {
      const label = {
        connecting: '門を探しています',
        waiting:    'ほかの人を待っています',
        ok:         s.detail,
        error:      'つながりませんでした'
      }[s.state] || s.detail;
      netbar(s.state, label);
    }
  });

  net.code = code;

  if (asHost){
    state = createState({ hostId: net.selfId, spicy });
    addPlayer(state, net.selfId, myName);
    bump();
  } else {
    state = null;
    $('#do-start').hidden = true;
    $('#do-retry').hidden = true;
    $('#lobby-status').textContent = '主を探しています…';
    net.hello({ name: myName });          // すでに繋がっている相手がいれば、その場で名乗る
    clearTimeout(seatTimer);
    seatTimer = setTimeout(showStuckHelp, 15000);
  }

  $('#lobby-code').textContent = code;
  $('#game-code').textContent = code;
  $('#lobby-hint').innerHTML =
    `この6文字を通話で読み上げてください。<br><span style="letter-spacing:.06em">${esc(codeToKana(code))}</span>`;
  show('s-lobby');
  render();
}

/* ══════════ 伝令 ══════════ */

/** 目に見えている繋がりから、在席と主を引き直す。 */
function syncPresence(){
  if (!state || !net) return null;
  const before = state.hostId;
  const host = refreshPresence(state, [meId(), ...net.peerIds()]);
  if (host !== before && host === meId() && state.phase !== 'lobby'){
    toast('あなたが主になりました');
  }
  return host;
}

function bump(){
  if (!state) return;
  state.v++;
  net.sync(state);
  render();
}

function onPeerJoin(id){
  syncPresence();
  if (isHost() && state){
    net.sync(state, id);                  // 主は、まず今の卓を見せる
    return;
  }
  // 客は、つながったその相手に名乗る。主でなければ黙って捨てられる。
  if (!state || !state.players?.[meId()]) net.hello({ name: myName }, id);
}

function onPeerLeave(){
  if (!state) return;
  syncPresence();
  if (isHost()){
    nudgeIfStuck(state);
    bump();
  } else {
    render();
  }
}

function onMessage(type, data, from){
  if (type === 'sync'){
    if (!data || typeof data !== 'object' || !data.players) return;
    // 主でない者が配った状態は受け取らない
    if (state && state.players[from] && from !== state.hostId) return;
    const wasPhase = state?.phase;
    state = data;
    syncPresence();
    if (wasPhase === undefined || wasPhase === 'lobby'){
      if (state.phase !== 'lobby' && state.phase !== 'end') show('s-game');
    }
    render();
    return;
  }

  if (type === 'hello'){
    if (!isHost() || !state) return;
    const p = addPlayer(state, from, data?.name);
    if (!p){ net.sync({ ...state, full: true }, from); return; }
    bump();
    return;
  }

  if (type === 'act'){
    if (!isHost() || !state) return;
    if (apply(state, data, from)) bump();
  }
}

function send(action){
  if (!state || !net) return;
  syncPresence();
  if (isHost()){
    if (apply(state, action, meId())) bump();
  } else {
    net.act(action);
  }
}

/* ══════════ 卓の操作 ══════════ */
$('#do-start').addEventListener('click', () => send({ t: 'start' }));

/* 席に着けないまま時間が過ぎたとき、詰まないための逃げ道 */
function showStuckHelp(){
  if (!net || state?.players?.[meId()]) return;
  $('#do-retry').hidden = false;
  $('#lobby-status').innerHTML =
    '主に届いていないようです。合言葉を確かめて、もう一度叩いてみてください。<br>' +
    '<span style="opacity:.7">それでもだめなら、全員で ' +
    `<b>${location.pathname}?net=mqtt</b> を開くと別の経路になります。</span>`;
}

$('#do-retry').addEventListener('click', () => {
  if (!net) return;
  net.hello({ name: myName });
  $('#do-retry').hidden = true;
  $('#lobby-status').textContent = 'もう一度、名乗りました…';
  clearTimeout(seatTimer);
  seatTimer = setTimeout(showStuckHelp, 12000);
});

$('#copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(net?.code ?? '');
    toast('合言葉を写しました');
  } catch {
    toast('うまく写せませんでした');
  }
});

$('#do-leave-lobby').addEventListener('click', leaveRoom);
$('#do-quit').addEventListener('click', () => {
  if (isHost()) send({ t: 'end' });
  else leaveRoom();
});
$('#do-again').addEventListener('click', () => { send({ t: 'again' }); show('s-lobby'); });
$('#do-home').addEventListener('click', leaveRoom);

function leaveRoom(){
  try { net?.leave(); } catch { /* すでに切れている */ }
  net = null; state = null;
  clearTimeout(seatTimer);
  $('#do-retry').hidden = true;
  $('#do-start').hidden = false;
  $('#netbar').hidden = true;
  document.body.classList.remove('with-netbar');
  show('s-home');
}

/* ══════════ 描く ══════════ */
function render(){
  if (!state) return;
  if (state.phase === 'lobby') { show('s-lobby'); renderLobby(); return; }
  if (state.phase === 'end')   { show('s-end');   renderEnd();   return; }
  show('s-game');
  renderGame();
}

function seatHTML(p, opts = {}){
  const a = arcanaOf(p);
  const cls = [
    'seat',
    p.id === meId() ? 'seat-you' : '',
    !p.present ? 'seat-gone' : '',
    opts.now ? 'seat-now' : ''
  ].filter(Boolean).join(' ');
  const tags = [];
  if (p.id === state.hostId) tags.push('主');
  if (p.id === meId()) tags.push('あなた');
  return `<li class="${cls}">
    <span class="seat-arcana" title="${esc(a.name)}">${a.n}</span>
    <span class="seat-name">${esc(p.name)}<span class="seat-arcana-name">${esc(a.name)}</span></span>
    ${tags.map(t => `<span class="seat-tag">${t}</span>`).join('')}
  </li>`;
}

function renderLobby(){
  const ps = seatedPlayers(state);
  $('#lobby-seats').innerHTML =
    ps.map(p => seatHTML(p)).join('') +
    Array.from({ length: Math.max(0, MAX_SEATS - ps.length) }, () =>
      `<li class="seat seat-gone"><span class="seat-arcana">·</span><span class="seat-name" style="opacity:.4">空席</span></li>`
    ).join('');

  const n = presentPlayers(state).length;
  const start = $('#do-start');

  if (state.players[meId()]){           // 席に着けたので、逃げ道はしまう
    clearTimeout(seatTimer);
    $('#do-retry').hidden = true;
  }

  if (isHost()){
    start.hidden = false;
    start.disabled = n < 2;
    start.textContent = n < 2 ? 'あと1人以上' : 'はじめる';
    $('#lobby-status').textContent = n < 2
      ? '合言葉を伝えて、誰か入ってくるのを待ちましょう。'
      : `${n}人。いつでもはじめられます。${state.spicy ? '' : 'きわどい札は抜いてあります。'}`;
  } else {
    start.hidden = true;
    $('#lobby-status').textContent = '主がはじめるのを待っています。';
  }
}

function fitClass(text){
  const n = [...text].length;
  if (n > 62) return 'card-text is-xlong';
  if (n > 34) return 'card-text is-long';
  return 'card-text';
}

function renderGame(){
  const cur = currentPlayer(state);
  const mine = currentId(state) === meId();

  /* 帯 */
  $('#turn-round').textContent = `第${state.round}巡`;
  const nameEl = $('#turn-name');
  nameEl.textContent = cur ? (mine ? `あなたの番` : `${cur.name} の番`) : '—';
  nameEl.classList.toggle('is-you', mine);

  /* 席 */
  $('#game-seats').innerHTML = seatedPlayers(state)
    .map(p => seatHTML(p, { now: p.id === currentId(state) })).join('');

  /* 縛り */
  const curses = state.curses ?? [];
  $('#curse-list').innerHTML = curses.length
    ? curses.map(c => `<li class="curse">
        <b>${esc(state.players[c.playerId]?.name ?? '?')}<span class="curse-left">あと${c.left}巡</span></b>
        ${wrapJa(c.x)}
      </li>`).join('')
    : '<li class="curses-empty">まだ無し</li>';

  /* 出来事 */
  $('#log').innerHTML = (state.log ?? []).slice(-14).reverse()
    .map(l => `<li>${esc(l.x)}</li>`).join('');

  /* 札 */
  const card = $('#card');
  const front = $('#card-front');
  const faceUp = state.phase === 'reveal' || state.phase === 'penalty';

  if (faceUp && state.card){
    const c = state.card;
    front.classList.remove('is-defi', 'is-peine');
    if (c.k === 'd') front.classList.add('is-defi');
    if (c.k === 'p') front.classList.add('is-peine');

    $('#card-kind').textContent = KIND_DECO[c.k];
    $('#card-cat').textContent  = CAT_LABEL[c.c] ?? '';
    $('#card-text').className   = fitClass(c.x);
    $('#card-text').innerHTML   = wrapJa(c.x);
    $('#card-num').textContent  = `N° ${String(c.i).padStart(3, '0')}`;

    const tgt = $('#card-target');
    if (c.target && state.players[c.target]){
      tgt.hidden = false;
      tgt.textContent = `通話相手 → ${state.players[c.target].name}`;
    } else {
      tgt.hidden = true;
    }
  }

  card.classList.toggle('is-face-up', faceUp);
  card.classList.toggle('is-shuffling', !faceUp && mine);

  /* 自分の番が回ってきた合図 */
  if (mine && lastTurnOwner !== state.turns){
    lastTurnOwner = state.turns;
    if (state.phase === 'turn') buzz([40, 60, 40]);
  }
  if (!mine) lastTurnOwner = null;

  renderCaption(cur, mine);
  renderActions(mine);

  $('#do-quit').textContent = isHost() ? 'おひらきにする' : '卓を離れる';
}

function myCurses(){
  return (state.curses ?? []).filter(c => c.playerId === currentId(state));
}

function renderCaption(cur, mine){
  const el = $('#stage-caption');
  const bound = myCurses();
  const boundNote = bound.length
    ? `<br><span class="cap-curse">縛り中：${bound.map(c => wrapJa(c.x)).join(' / ')}</span>`
    : '';

  const who = cur ? cur.name : '誰か';
  let text = '';

  if (state.phase === 'turn'){
    text = mine
      ? '*真実*か*挑戦*か、札を選んでください。'
      : `${who} が札を選んでいます。`;
  } else if (state.phase === 'reveal'){
    const kind = KIND_LABEL[state.card?.k] ?? '';
    text = mine
      ? 'やり切ったら「やった」。無理なら逃げられますが、*罰の札*が引かれます。'
      : `${who} の${kind}。聞き役に回りましょう。`;
  } else if (state.phase === 'penalty'){
    text = mine
      ? '逃げた代償です。断れません。'
      : `${who} が罰を引きました。`;
  }

  el.innerHTML = say(text) + boundNote;
}

function renderActions(mine){
  const box = $('#actions');
  if (!mine){ box.innerHTML = ''; return; }

  if (state.phase === 'turn'){
    box.innerHTML = `
      <button class="btn btn-choice is-verite" data-act="t"><small>VÉRITÉ</small>真実</button>
      <button class="btn btn-choice is-defi"   data-act="d"><small>DÉFI</small>挑戦</button>`;
  } else if (state.phase === 'reveal'){
    box.innerHTML = `
      <button class="btn btn-gold" data-act="done">やった</button>
      <button class="btn btn-ghost" data-act="pass">逃げる（罰を引く）</button>`;
  } else if (state.phase === 'penalty'){
    box.innerHTML = `<button class="btn btn-gold" data-act="took">受けた</button>`;
  } else {
    box.innerHTML = '';
  }
}

$('#actions').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  b.closest('.actions').querySelectorAll('button').forEach(x => x.disabled = true);
  if (a === 't' || a === 'd') send({ t: 'choose', kind: a });
  else send({ t: a });
});

function renderEnd(){
  const ps = seatedPlayers(state);
  const total = ps.reduce((n, p) => n + p.truths + p.dares, 0);
  $('#end-lead').innerHTML =
    `${state.round - 1 > 0 ? `${state.round}巡、` : ''}あわせて<b>${total}</b>枚の札がめくられました。`;

  $('#end-tally').innerHTML = ps.map(p => `
    <li>
      <span class="seat-arcana">${arcanaOf(p).n}</span>
      <span class="tally-name">${esc(p.name)}</span>
      <span class="tally-unit">真実</span><span class="tally-num">${p.truths}</span>
      <span class="tally-unit">挑戦</span><span class="tally-num">${p.dares}</span>
      <span class="tally-unit">逃げ</span><span class="tally-num">${p.passes}</span>
    </li>`).join('');

  $('#do-again').hidden = !isHost();
}

/* ══════════ 開発用の覗き窓（?debug のときだけ） ══════════ */
if (new URLSearchParams(location.search).has('debug')){
  window.__st = () => state;
  window.__net = () => net;
}

/* ══════════ 離脱 ══════════ */
window.addEventListener('pagehide', () => { try { net?.leave(); } catch { /* 閉じるだけ */ } });
