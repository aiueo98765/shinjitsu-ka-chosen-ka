/* ══════════════════════════════════════════════════════
   game.js ─ 卓の決まりごと
   状態は主（ホスト）が一手に握り、変わるたび全員へ配る。
   ここに書いてある関数は主の端末でしか呼ばれない。
   ══════════════════════════════════════════════════════ */

import { CARDS, CAT_LABEL } from '../data/cards.js';

/** 席に配る大アルカナ。6人までなので頭から六枚。 */
export const ARCANA = [
  { n: 'I',   name: '魔術師' },
  { n: 'II',  name: '女教皇' },
  { n: 'III', name: '女帝'   },
  { n: 'IV',  name: '皇帝'   },
  { n: 'V',   name: '教皇'   },
  { n: 'VI',  name: '恋人'   },
  { n: 'VII', name: '戦車'   },
  { n: 'VIII',name: '力'     }
];

export const MAX_SEATS = 6;
export const KIND_LABEL = { t: '真実', d: '挑戦', p: '罰' };
export const KIND_DECO  = { t: 'VÉRITÉ', d: 'DÉFI', p: 'PEINE' };
export { CAT_LABEL };

/* ══════════ 状態をつくる ══════════ */

export function createState({ hostId, spicy }){
  return {
    v: 0,
    hostId,
    phase: 'lobby',      // lobby | turn | reveal | penalty | end
    spicy: spicy !== false,
    players: {},
    order: [],
    turnIdx: 0,
    round: 1,
    turns: 0,
    card: null,          // { i, k, c, x, target }
    curses: [],          // { id, playerId, x, left }
    used: [],
    log: []
  };
}

export function addPlayer(state, id, name){
  const trimmed = (name || '').trim().slice(0, 10) || 'ななし';

  // 同じ名前で抜けた席が残っていれば、そこへ座り直す
  const ghost = state.order
    .map(pid => state.players[pid])
    .find(p => p && !p.present && p.name === trimmed);

  if (ghost){
    const at = state.order.indexOf(ghost.id);
    delete state.players[ghost.id];
    state.order[at] = id;
    state.players[id] = { ...ghost, id, present: true };
    return state.players[id];
  }

  if (state.order.length >= MAX_SEATS) return null;
  if (state.players[id]) { state.players[id].present = true; return state.players[id]; }

  const seat = state.order.length;
  state.players[id] = {
    id, name: trimmed, seat,
    present: true,
    truths: 0, dares: 0, passes: 0
  };
  state.order.push(id);
  return state.players[id];
}

/**
 * 誰が居るかは、各端末が自分の目で見た繋がり具合から決める。
 * 主から配られる状態に混ぜないので、途切れても食い違いが残らない。
 */
export function refreshPresence(state, liveIds){
  const live = new Set(liveIds);
  for (const id of Object.keys(state.players)){
    state.players[id].present = live.has(id);
  }
  state.hostId = resolveHost(state);
  return state.hostId;
}

/* ══════════ 席まわりの小道具 ══════════ */

export const seatedPlayers = s => s.order.map(id => s.players[id]).filter(Boolean);
export const presentPlayers = s => seatedPlayers(s).filter(p => p.present);
export const currentId = s => s.order[s.turnIdx] ?? null;
export const currentPlayer = s => s.players[currentId(s)] ?? null;
export const arcanaOf = p => ARCANA[p?.seat ?? 0] ?? ARCANA[0];

/**
 * 主は「席順で一番前に居る人」。持ち回りではなく、その場で毎回計算する。
 * 全員が同じ順番表を見ているので、誰が数えても同じ答えになる。
 */
export function resolveHost(state){
  const next = seatedPlayers(state).find(p => p.present);
  return next ? next.id : state.hostId;
}

/* ══════════ 山札 ══════════ */

function pool(state, kind){
  return CARDS.filter(c => c.k === kind && (state.spicy || !c.r));
}

function drawCard(state, kind){
  const deck = pool(state, kind);
  if (!deck.length) return null;

  const used = new Set(state.used);
  let fresh = deck.filter(c => !used.has(c.i));

  if (!fresh.length){                              // 一巡したら、その種類だけ山を戻す
    const ids = new Set(deck.map(c => c.i));
    state.used = state.used.filter(i => !ids.has(i));
    fresh = deck;
  }

  const card = fresh[Math.floor(Math.random() * fresh.length)];
  state.used.push(card.i);

  const out = { i: card.i, k: card.k, c: card.c, x: card.x, n: card.n || 0 };

  if (card.p){                                     // 相手を名指しする札
    const others = presentPlayers(state).filter(p => p.id !== currentId(state));
    if (others.length) out.target = others[Math.floor(Math.random() * others.length)].id;
  }
  return out;
}

/* ══════════ 記録 ══════════ */

function note(state, text){
  state.log.push({ x: text, ts: Date.now() });
  if (state.log.length > 40) state.log.shift();
}

/* ══════════ 手番を送る ══════════ */

function advance(state){
  state.card = null;
  state.turns++;

  const n = state.order.length;
  if (!n) return;

  let guard = 0;
  do {
    state.turnIdx = (state.turnIdx + 1) % n;
    if (state.turnIdx === 0){                      // 一巡した
      state.round++;
      state.curses = state.curses
        .map(c => ({ ...c, left: c.left - 1 }))
        .filter(c => c.left > 0);
    }
    guard++;
  } while (guard <= n && !state.players[currentId(state)]?.present);

  state.phase = 'turn';
}

/* ══════════ 主が受け取る指図 ══════════ */

export function apply(state, action, fromId){
  const isHost = fromId === state.hostId;
  const isTurn = fromId === currentId(state);

  switch (action.t){

    case 'start':
      if (!isHost || state.phase !== 'lobby') return false;
      if (presentPlayers(state).length < 2) return false;
      state.phase = 'turn';
      state.turnIdx = 0;
      state.round = 1;
      state.turns = 0;
      note(state, '卓がひらきました');
      return true;

    case 'choose': {
      if (state.phase !== 'turn' || !isTurn) return false;
      const kind = action.kind === 'd' ? 'd' : 't';
      const card = drawCard(state, kind);
      if (!card) return false;
      state.card = card;
      state.phase = 'reveal';
      const me = state.players[fromId];
      if (me) kind === 't' ? me.truths++ : me.dares++;
      note(state, `${me?.name ?? '?'} は${KIND_LABEL[kind]}を選んだ`);
      return true;
    }

    case 'done':
      if (state.phase !== 'reveal' || !isTurn) return false;
      note(state, `${state.players[fromId]?.name ?? '?'} はやり切った`);
      advance(state);
      return true;

    case 'pass': {
      if (state.phase !== 'reveal' || !isTurn) return false;
      const me = state.players[fromId];
      if (me) me.passes++;
      const peine = drawCard(state, 'p');
      if (!peine) { advance(state); return true; }
      state.card = peine;
      state.phase = 'penalty';
      note(state, `${me?.name ?? '?'} は逃げた`);
      return true;
    }

    case 'took': {
      if (state.phase !== 'penalty' || !isTurn) return false;
      const card = state.card;
      if (card?.n > 0){
        state.curses.push({
          id: `${fromId}-${card.i}-${state.turns}`,
          playerId: fromId,
          x: card.x,
          left: card.n
        });
      }
      advance(state);
      return true;
    }

    case 'end':
      if (!isHost) return false;
      state.phase = 'end';
      state.card = null;
      return true;

    case 'again': {
      if (!isHost) return false;
      state.phase = 'lobby';
      state.card = null;
      state.curses = [];
      state.used = [];
      state.log = [];
      state.turnIdx = 0;
      state.round = 1;
      state.turns = 0;
      for (const p of seatedPlayers(state)){ p.truths = 0; p.dares = 0; p.passes = 0; }
      return true;
    }

    case 'spicy':
      if (!isHost || state.phase !== 'lobby') return false;
      state.spicy = !!action.on;
      return true;

    default:
      return false;
  }
}

/** 手番の人が消えたら、卓を止めずに送る。 */
export function nudgeIfStuck(state){
  if (state.phase === 'lobby' || state.phase === 'end') return false;
  if (!state.order.length) return false;
  if (state.players[currentId(state)]?.present) return false;
  if (!presentPlayers(state).length) return false;
  note(state, `${state.players[currentId(state)]?.name ?? '誰か'} が席を外したので飛ばします`);
  advance(state);
  return true;
}
