/* ══════════════════════════════════════════════════════
   net.js ─ P2P の足回り
   サーバーを持たない。Trystero が公開リレーで名刺交換だけを
   仲介し、以後の会話は端末どうしの直結（WebRTC）で流れる。
   ══════════════════════════════════════════════════════ */

const APP_ID = 'shinjitsu-ka-chosen-ka';

const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/** 合言葉に使う文字。0/O, 1/I/L のような読み違いの元を外してある。 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function makeCode(len = 6){
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return out;
}

/** 合言葉は声で伝わる。全角も小文字も受け、山にない文字は落とす。 */
export function normalizeCode(raw){
  return (raw || '')
    .replace(/[ａ-ｚＡ-Ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toUpperCase()
    .split('')
    .filter(c => CODE_ALPHABET.includes(c))
    .join('')
    .slice(0, 6);
}

/** 読み上げ用の仮名。「ビー」と「ディー」を取り違えないための添え書き。 */
const KANA = {
  A:'エー', B:'ビー', C:'シー', D:'ディー', E:'イー', F:'エフ', G:'ジー', H:'エイチ',
  J:'ジェイ', K:'ケー', M:'エム', N:'エヌ', P:'ピー', Q:'キュー', R:'アール', S:'エス',
  T:'ティー', U:'ユー', V:'ブイ', W:'ダブリュー', X:'エックス', Y:'ワイ', Z:'ゼット',
  2:'に', 3:'さん', 4:'よん', 5:'ご', 6:'ろく', 7:'なな', 8:'はち', 9:'きゅう'
};
export function codeToKana(code){
  return (code || '').split('').map(c => KANA[c] || c).join('・');
}

async function loadStrategy(name){
  if (name === 'mqtt') return import('../vendor/trystero-mqtt.js');
  return import('../vendor/trystero-nostr.js');
}

/**
 * 部屋につなぐ。
 * @param {object} o
 * @param {string} o.code       合言葉
 * @param {string} o.strategy   'nostr' | 'mqtt'
 * @param {(id:string)=>void} o.onJoin
 * @param {(id:string)=>void} o.onLeave
 * @param {(type:string, payload:any, from:string)=>void} o.onMessage
 * @param {(s:{state:string, detail?:string})=>void} o.onStatus
 */
export async function connect({ code, strategy = 'nostr', onJoin, onLeave, onMessage, onStatus }){
  onStatus?.({ state: 'connecting', detail: '館の門を探しています' });

  const lib = await loadStrategy(strategy);
  const { joinRoom, selfId } = lib;

  let room;
  try {
    room = joinRoom(
      {
        appId: APP_ID,
        password: 'arcane:' + code,                // 合言葉を知らない者には中身が読めない
        relayConfig: { warnOnRelayFailure: false }, // 落ちているリレーは黙って迂回する
        // 同じブラウザの別タブ同士で試すとき、mDNS の候補が解決できず繋がらない。
        // 本番でこれを入れると逆に繋がらなくなるので、手元の開発時だけに限る。
        ...(IS_LOCAL && new URLSearchParams(location.search).has('debug')
          ? { _test_only_mdnsHostFallbackToLoopback: true }
          : {})
      },
      code,
      {
        onJoinError: d => {
          console.error('[net] join error', d);
          onStatus?.({ state: 'error', detail: 'つながりませんでした' });
        }
      }
    );
  } catch (err){
    console.error('[net] joinRoom threw', err);
    onStatus?.({ state: 'error', detail: 'つながりませんでした' });
    throw err;
  }

  /* ── やりとりする三つの伝令 ── */
  const chSync  = room.makeAction('sync',  { onMessage: (d, c) => onMessage?.('sync',  d, c.peerId) });
  const chHello = room.makeAction('hello', { onMessage: (d, c) => onMessage?.('hello', d, c.peerId) });
  const chAct   = room.makeAction('act',   { onMessage: (d, c) => onMessage?.('act',   d, c.peerId) });

  room.onPeerJoin = id => { onJoin?.(id); refreshStatus(); };
  room.onPeerLeave = id => { onLeave?.(id); refreshStatus(); };

  function refreshStatus(){
    const n = Object.keys(room.getPeers()).length;
    onStatus?.({
      state: n > 0 ? 'ok' : 'waiting',
      detail: n > 0 ? `${n + 1}人がつながっています` : 'ほかの人を待っています'
    });
  }
  refreshStatus();

  return {
    selfId,
    strategy,
    peerCount: () => Object.keys(room.getPeers()).length,
    peerIds: () => Object.keys(room.getPeers()),
    sync:  (data, target) => chSync.send(data,  target ? { target } : undefined),
    hello: (data, target) => chHello.send(data, target ? { target } : undefined),
    act:   (data, target) => chAct.send(data,   target ? { target } : undefined),
    leave: () => room.leave()
  };
}
