/* Bracket Attack — shared utilities */
'use strict';

const $  = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ---------- game presets ---------- */

const GAME_PRESETS = [
  { name: 'Cornhole',    icon: '🌽', target: 21,  winBy: 0, notes: 'Cancellation scoring. Bag in the hole = 3, on the board = 1.' },
  { name: 'Horseshoes',  icon: '🐴', target: 21,  winBy: 0, notes: 'Ringer = 3, leaner = 2, closest within a shoe = 1.' },
  { name: 'Ladder Golf', icon: '🪜', target: 21,  winBy: 0, notes: 'Top rung = 3, middle = 2, bottom = 1. Exact 21 to win.' },
  { name: 'Lawn Darts',  icon: '🎯', target: 21,  winBy: 0, notes: 'In the ring = 3, closest to the ring = 1. Cancellation scoring.' },
  { name: 'Washers',     icon: '🪙', target: 21,  winBy: 0, notes: 'In the cup = 3, in the box = 1. Cancellation scoring.' },
  { name: 'Junkyard Cannon', icon: '💥', target: 21, winBy: 0, notes: 'Direct hit = 3, scrap zone = 1. Adjust to whatever the cannon crew agrees on before launch.' },
  { name: 'Giant Beer Pong', icon: '🍺', target: 6, winBy: 0, notes: 'Sunk bucket = 1 point. First team to sink all 6 wins. Rebuttal shot optional.' },
  { name: 'Field Pong',  icon: '🥤', target: 6,   winBy: 0, notes: 'Beer pong at yard scale — buckets on the field, throw from your line. Sunk bucket = 1 point; first team to clear all 6 wins. Bounce shots count double if both teams agree before the game.' },
  { name: 'Bocce Ball',  icon: '🎱', target: 12,  winBy: 0, notes: 'Closest to the pallino scores — 1 per ball inside the opponent\'s best, kissing the pallino = 2. First to 12.' },
  { name: 'Volley Strike', icon: '🏐', target: 21, winBy: 2, notes: 'Yard volleyball, junkyard rules. Rally scoring to 21, win by 2. Net (or rope) height disputes settled by the hosts.' },
  { name: 'Badminton',   icon: '🏸', target: 21,  winBy: 2, notes: 'Rally scoring to 21, win by 2. Birdie into the scrap pile is a fault.' },
  { name: 'Can Jam',     icon: '🥏', target: 21,  winBy: 0, notes: 'SCORING — Dinger (1): thrower hits the can after the partner redirects the disc into the side. Deuce (2): thrower hits the can directly, no help. Bucket (3): partner deflects the disc so it lands inside the can. INSTANT WIN: thrower slots the disc straight into the can with no help — game ends immediately.\nDEFLECTING — the partner can move anywhere but gets ONE touch per throw: no catching, carrying, or double-hits. Disc hits the ground before the can = no points. If the other team interferes with a throw, the throwing team is awarded 3 points.\nWINNING — score EXACTLY 21. Going over subtracts that throw\'s points from your score instead of adding. Equal turns: if the first team hits 21, the second team gets one last hammer turn to tie or hit an instant win.' },
  { name: 'Custom',      icon: '🏅', target: 11,  winBy: 0, notes: '' },
];

/* ---------- fun random team names (junkyard grade) ---------- */

const TEAM_ADJ = ['Rusty', 'Greasy', 'Scrappy', 'Dented', 'Busted', 'Crooked',
  'Salvaged', 'Smashed', 'Oily', 'Grimy', 'Diesel', 'Chrome', 'Gritty', 'Clunky',
  'Rickety', 'Sparky', 'Burnt', 'Bent', 'Turbo', "Smokin'"];
const TEAM_NOUN = ['Wrenches', 'Hubcaps', 'Mufflers', 'Crowbars', 'Sprockets',
  'Pistons', 'Lugnuts', 'Gaskets', 'Scrappers', 'Rustbuckets', 'Tailpipes',
  'Grease Monkeys', 'Spark Plugs', 'Wreckers', 'Axles', 'Radiators',
  'Dumpster Divers', 'Bolt Cutters', 'Junk Hounds', 'Magpies'];

function randomTeamName(used = new Set()) {
  for (let i = 0; i < 60; i++) {
    const n = TEAM_ADJ[Math.floor(Math.random() * TEAM_ADJ.length)] + ' ' +
              TEAM_NOUN[Math.floor(Math.random() * TEAM_NOUN.length)];
    if (!used.has(n)) { used.add(n); return n; }
  }
  return 'Team ' + uid('').slice(1, 5).toUpperCase();
}

/* ---------- toasts ---------- */

function toast(msg, type = 'info') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = msg;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, 4500);
}

/* ---------- confetti ---------- */

const Confetti = (() => {
  const canvas = () => $('#confetti');
  let parts = [], raf = null;
  const COLORS = ['#ffb400', '#ff5a1e', '#e0925a', '#c8d0e0', '#06d6a0', '#ffd166'];

  function resize() {
    const c = canvas();
    c.width = innerWidth;
    c.height = innerHeight;
  }

  function tick() {
    const c = canvas(), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    parts = parts.filter(p => p.y < c.height + 30 && p.life > 0);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.rot += p.vr; p.life--;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
      ctx.restore();
    }
    if (parts.length) raf = requestAnimationFrame(tick);
    else { raf = null; ctx.clearRect(0, 0, c.width, c.height); }
  }

  function burst(n = 160) {
    resize();
    const c = canvas();
    for (let i = 0; i < n; i++) {
      parts.push({
        x: c.width / 2 + (Math.random() - 0.5) * c.width * 0.5,
        y: c.height * 0.25,
        vx: (Math.random() - 0.5) * 12,
        vy: -Math.random() * 9 - 2,
        s: 6 + Math.random() * 8,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        life: 220,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      });
    }
    if (!raf) raf = requestAnimationFrame(tick);
  }

  addEventListener('resize', resize);
  return { burst };
})();
