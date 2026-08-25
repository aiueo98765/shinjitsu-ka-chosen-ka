/* ══════════════════════════════════════════════════════
   cards.js ─ 山札のまとめ役
   ・k … 札の種類  t=真実 / d=挑戦 / p=罰
   ・c … 分類（下の CAT_LABEL の見出しに出る）
   ・x … 本文
   ・r … 1 なら、きわどい札。部屋の設定で抜ける
   ・p … 1 なら、通話相手を一人名指しする札
   ・n … 罰のうち、何巡か効き続ける縛り
   ══════════════════════════════════════════════════════ */

import { TRUTH } from './truth.js';
import { DARE } from './dare.js';
import { PEINE } from './peine.js';
import { DEEP_TRUTH, DEEP_DARE } from './deep.js';

export const CAT_LABEL = {
  /* 真実 */
  love:   '恋',
  spicy:  '情事',
  shame:  '黒歴史',
  honne:  '本音',
  money:  '金と仕事',
  phone:  '端末の中',
  deep:   '深いところ',
  life:   '生き方',
  bond:   '絆',
  debate: '夜ふかしの議論',
  /* 挑戦 */
  voice:  '声',
  kokoro: '心を渡す',
  confess:'暴露',
  geinin: '一発芸',
  /* 罰 */
  shibari:'縛り',
  ippatsu:'その場かぎり'
};

export const CARDS = [...TRUTH, ...DEEP_TRUTH, ...DARE, ...DEEP_DARE, ...PEINE].map((c, idx) => ({ ...c, i: idx + 1 }));

export const COUNT = CARDS.reduce((acc, c) => {
  acc[c.k] = (acc[c.k] || 0) + 1;
  if (c.r) acc.spicy = (acc.spicy || 0) + 1;
  return acc;
}, {});
