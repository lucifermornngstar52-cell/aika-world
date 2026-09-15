'use strict';
/* ═══════════════════════════════════════════════════════════════════
   АЙКА МИР v2 — живая пиксельная деревня.
   Мир генерируется случайно. Жители думают, строят, заводят детей.
   Ночью из тьмы приходят слаймы. В лесу живут волки и кролики.
   Идёт дождь. Деревня сражается, растёт и эволюционирует.
   ═══════════════════════════════════════════════════════════════════ */

// ── Константы мира ────────────────────────────────────────────────
const W = 120, H = 76, TILE = 8;
const MAP_W = W * TILE, MAP_H = H * TILE;
const DAY_LEN = 240; // сим-секунд на сутки

// ── Глобальное состояние ──────────────────────────────────────────
let world = null;
let objects = [];
let objAt = new Map();
let villagers = [];
let animals = [];   // кролики и волки
let monsters = [];  // слаймы (враги, приходят ночью)
let campfire = { x: 0, y: 0 };
let huts = [];
let farms = [];     // объекты типа 'farm' тоже лежат в objects
let stocks = { wood: 0, berries: 6 };
let totalWood = 0;
let pendingBuild = null;   // { kind:'hut'|'farm', x, y, assigned }
let settlersThresholds = [45, 110, 200, 320, 470];
let settlersSpawned = 0;
let simTime = 0;
let simSpeed = 1, paused = false;
let seed = (Date.now() % 2147483647) | 0;
let rng = null;
let camX = 0, camY = 0, zoom = 1.6;
let selected = null;
let nextId = 1;
let lastPhase = 0;
let weather = { rain: false, t: 80, bolt: 0 };
const regrowQueue = [];
const SIM = { monsterWaves: 0, monsterKills: 0, deaths: 0, births: 0, harvests: 0, rains: 0 };

// ── Утилиты ───────────────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const key = (x, y) => x + y * W;
const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function makeNoise(s) {
  function hash(ix, iy) {
    let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(s, 1442695041);
    n = Math.imul(n ^ n >>> 13, 1274126177);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967295;
  }
  const sm = t => t * t * (3 - 2 * t);
  function n2(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = sm(x - ix), fy = sm(y - iy);
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  return function (x, y) {
    let v = 0, amp = 0.5, f = 1;
    for (let o = 0; o < 4; o++) { v += amp * n2(x * f, y * f); amp *= 0.5; f *= 2; }
    return v / 0.9375;
  };
}

// ── Типы тайлов ───────────────────────────────────────────────────
const TILE_COLORS = {
  0: [27, 54, 93], 1: [52, 110, 166], 2: [216, 196, 122],
  3: [94, 140, 66], 4: [110, 156, 74], 5: [120, 120, 128], 6: [225, 228, 235]
};
const isWalkTile = t => t >= 2 && t <= 4;
const BLOCKING = new Set(['tree', 'pine', 'bush', 'stone', 'hut', 'campfire', 'farm']);

function blockingAt(x, y) {
  const o = objAt.get(key(x, y));
  return o && BLOCKING.has(o.type);
}
const walkable = (x, y) => inb(x, y) && isWalkTile(world[key(x, y)]) && !blockingAt(x, y);

function randWalkable(minDistFromCamp, maxTry) {
  for (let i = 0; i < (maxTry || 300); i++) {
    const x = Math.floor(rng() * W), y = Math.floor(rng() * H);
    if (walkable(x, y) && (!minDistFromCamp || dist2(x, y, campfire.x, campfire.y) > minDistFromCamp * minDistFromCamp))
      return { x: x + 0.5, y: y + 0.5 };
  }
  return { x: campfire.x + 0.5, y: campfire.y + 2.5 };
}

// ── Генерация мира ────────────────────────────────────────────────
function genWorld(s) {
  rng = mulberry32(s);
  const nE = makeNoise(s), nM = makeNoise(s + 7777);
  world = new Uint8Array(W * H);
  const moistArr = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x / W - 0.5) * 2, dy = (y / H - 0.5) * 2;
      const grad = Math.sqrt(dx * dx + dy * dy);
      let e = nE(x * 0.05, y * 0.05) * 0.85 + (1 - grad) * 0.35 - 0.1;
      const m = nM(x * 0.06 + 400, y * 0.06);
      moistArr[key(x, y)] = m;
      let t;
      if (e < 0.30) t = 0;
      else if (e < 0.38) t = 1;
      else if (e < 0.44) t = 2;
      else if (e > 0.82) t = 6;
      else if (e > 0.74) t = 5;
      else t = m > 0.55 ? 4 : 3;
      world[key(x, y)] = t;
    }
  }
  objects = []; objAt = new Map();
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const t = world[key(x, y)];
      const m = moistArr[key(x, y)];
      const r = rng();
      if (t === 4 && r < 0.045) addObject('bush', x, y);
      else if (t === 3 && r < (m > 0.45 ? 0.26 : 0.06)) addObject(m < 0.33 ? 'pine' : 'tree', x, y);
      else if (t === 4 && r < 0.07) addObject('tree', x, y);
      else if (t === 3 && r < 0.19) addObject('flower', x, y);
      else if ((t === 5 || t === 2) && r < 0.02) addObject('stone', x, y);
    }
  }
  // место для деревни
  let best = null, bestScore = -1;
  for (let ty = 12; ty < H - 12; ty += 2) {
    for (let tx = 12; tx < W - 12; tx += 2) {
      if (!walkable(tx, ty)) continue;
      let score = 0;
      for (let k = 0; k < 40; k++) {
        const ox = tx + Math.floor(rng() * 13) - 6, oy = ty + Math.floor(rng() * 13) - 6;
        if (walkable(ox, oy)) score++;
      }
      score += (400 - dist2(tx, ty, W / 2, H / 2) * 0.5) * 0.02;
      if (score > bestScore) { bestScore = score; best = { x: tx, y: ty }; }
    }
  }
  if (!best) best = { x: W >> 1, y: H >> 1 };
  campfire.x = best.x; campfire.y = best.y;
  for (let y = best.y - 3; y <= best.y + 3; y++)
    for (let x = best.x - 3; x <= best.x + 3; x++) {
      const o = objAt.get(key(x, y));
      if (o && ['tree', 'bush', 'stone', 'pine'].includes(o.type)) removeObject(o);
    }
  addObject('campfire', campfire.x, campfire.y);
  huts = [];
  addHut(best.x - 3, best.y - 1);
  addHut(best.x + 3, best.y + 1);
  farms = [];

  villagers = [];
  const spawn = [
    [best.x - 2, best.y + 2], [best.x + 2, best.y - 2],
    [best.x - 4, best.y], [best.x + 4, best.y],
    [best.x + 1, best.y + 3], [best.x - 1, best.y - 3]
  ];
  for (let i = 0; i < 6; i++) {
    const p = spawn[i];
    if (!walkable(p[0], p[1])) { p[0] = best.x; p[1] = best.y + i; }
    villagers.push(makeVillager(p[0] + 0.5, p[1] + 0.5));
  }

  // животные
  animals = [];
  for (let i = 0; i < 14; i++) {
    const p = randWalkable(8);
    animals.push({ id: nextId++, kind: 'rabbit', x: p.x, y: p.y, hp: 5, state: 'idle', t: rng() * 2, dirX: 0, dirY: 0, facing: 1, animT: 0 });
  }
  for (let i = 0; i < 5; i++) {
    const p = randWalkable(14);
    animals.push({ id: nextId++, kind: 'wolf', x: p.x, y: p.y, hp: 12, state: 'idle', t: rng() * 3, dirX: 0, dirY: 0, facing: 1, animT: 0, preyId: 0 });
  }
  monsters = [];
  stocks = { wood: 0, berries: 6 };
  totalWood = 0; pendingBuild = null; settlersSpawned = 0;
  simTime = 0; selected = null; lastPhase = 0;
  weather = { rain: false, t: 60 + rng() * 120, bolt: 0 };
  SIM.monsterWaves = 0; SIM.monsterKills = 0; SIM.deaths = 0; SIM.births = 0; SIM.harvests = 0; SIM.rains = 0;
  renderMapCanvas();
  logEvent('🔥', 'Деревня основана! Костёр горит, жители готовы к труду.');
}

function addObject(type, x, y) {
  const o = { id: nextId++, type, x, y };
  if (type === 'tree' || type === 'pine') { o.variant = Math.floor(rng() * 3); o.regrow = 0; }
  if (type === 'bush') { o.depleted = false; o.regrowAt = 0; }
  if (type === 'farm') { o.stage = 1; o.growAt = 0; farms.push(o); }
  objects.push(o); objAt.set(key(x, y), o);
  return o;
}
function removeObject(o) {
  const i = objects.indexOf(o);
  if (i >= 0) objects.splice(i, 1);
  objAt.delete(key(o.x, o.y));
  if (o.type === 'farm') { const j = farms.indexOf(o); if (j >= 0) farms.splice(j, 1); }
}
function addHut(x, y) {
  if (!walkable(x, y)) return false;
  addObject('hut', x, y);
  huts.push({ x, y });
  return true;
}

// ── Текстуры ─────────────────────────────────────────────────────
const tileTex = {};
const spr = {};

function px(g, x, y, r, g2, b) { g.fillStyle = `rgb(${r},${g2},${b})`; g.fillRect(x, y, 1, 1); }
function jitter(base, r) {
  return [
    Math.max(0, Math.min(255, base[0] + Math.floor((r() - 0.5) * 26))),
    Math.max(0, Math.min(255, base[1] + Math.floor((r() - 0.5) * 26))),
    Math.max(0, Math.min(255, base[2] + Math.floor((r() - 0.5) * 26)))
  ];
}

function makeTextures() {
  const r = mulberry32(12345);
  for (const t of Object.keys(TILE_COLORS)) {
    tileTex[t] = [];
    for (let v = 0; v < 4; v++) {
      const c = document.createElement('canvas');
      c.width = TILE; c.height = TILE;
      const g = c.getContext('2d');
      const base = TILE_COLORS[t];
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) {
          const col = jitter(base, r);
          px(g, x, y, col[0], col[1], col[2]);
        }
      if (+t === 3 || +t === 4) {
        for (let k = 0; k < 3; k++) {
          const x = Math.floor(r() * 8), y = Math.floor(r() * 8);
          const d = r() < 0.5 ? [62, 104, 44] : [128, 172, 88];
          px(g, x, y, d[0], d[1], d[2]);
        }
      }
      if (+t === 2) {
        for (let k = 0; k < 2; k++)
          px(g, Math.floor(r() * 8), Math.floor(r() * 8), 190, 170, 100);
      }
      if (+t === 5) {
        const x0 = Math.floor(r() * 6), y0 = Math.floor(r() * 8);
        px(g, x0, y0, 90, 90, 98); px(g, x0 + 1, y0, 90, 90, 98);
      }
      if (+t === 4 && r() < 0.5) {
        const fx2 = Math.floor(r() * 7), fy = Math.floor(r() * 7);
        const col = r() < 0.5 ? [235, 220, 120] : [220, 130, 150];
        px(g, fx2, fy, col[0], col[1], col[2]);
      }
      tileTex[t].push(c);
    }
  }
  // деревья
  spr.tree = [];
  for (let v = 0; v < 3; v++) {
    const c = document.createElement('canvas'); c.width = 10; c.height = 14;
    const g = c.getContext('2d');
    g.fillStyle = 'rgb(92,64,38)'; g.fillRect(4, 9, 2, 5);
    g.fillStyle = 'rgb(70,48,28)'; g.fillRect(5, 10, 1, 4);
    const leaves = [[2,2],[3,1],[4,1],[5,1],[6,2],[7,3],[1,3],[2,3],[3,2],[4,2],[5,2],[6,3],[7,4],[1,4],[2,4],[3,3],[4,3],[5,3],[6,4],[2,5],[3,4],[4,4],[5,4],[3,5],[4,5],[5,5],[6,5]];
    for (const [lx, ly] of leaves) {
      const shade = r();
      const col = shade < 0.3 ? [40, 92, 34] : shade < 0.7 ? [58, 116, 44] : [78, 140, 58];
      px(g, lx + 1, ly, col[0], col[1], col[2]);
    }
    px(g, 4, 0, 58, 116, 44); px(g, 5, 0, 58, 116, 44);
    spr.tree.push(c);
  }
  // сосны
  spr.pine = [];
  for (let v = 0; v < 3; v++) {
    const c = document.createElement('canvas'); c.width = 10; c.height = 14;
    const g = c.getContext('2d');
    g.fillStyle = 'rgb(80,56,34)'; g.fillRect(4, 11, 2, 3);
    for (let row = 0; row < 10; row++) {
      const width = 2 + Math.floor(row * 0.6);
      for (let x = 5 - Math.ceil(width / 2); x <= 4 + Math.ceil(width / 2); x++) {
        const shade = r();
        const col = shade < 0.4 ? [24, 70, 40] : [34, 88, 50];
        px(g, Math.max(0, x), row + 1, col[0], col[1], col[2]);
      }
    }
    spr.pine.push(c);
  }
  // кусты
  spr.bush = [makeBush(false, r), makeBush(true, r)];
  function makeBush(depleted, r) {
    const c = document.createElement('canvas'); c.width = 10; c.height = 8;
    const g = c.getContext('2d');
    for (let y = 2; y < 7; y++) for (let x = 1; x < 9; x++) {
      const d = Math.abs(x - 4.5) + (6 - y);
      if (d < 6) {
        const col = r() < 0.4 ? [34, 86, 40] : [52, 110, 52];
        px(g, x, y, col[0], col[1], col[2]);
      }
    }
    if (!depleted) for (let k = 0; k < 5; k++)
      px(g, 2 + Math.floor(r() * 6), 2 + Math.floor(r() * 4), 210, 60, 70);
    return c;
  }
  // камень
  spr.stone = (() => {
    const c = document.createElement('canvas'); c.width = 8; c.height = 7;
    const g = c.getContext('2d');
    for (let y = 1; y < 6; y++) for (let x = 1; x < 7; x++) {
      if (Math.abs(x - 3.5) + Math.abs(y - 3) < 4) {
        const col = r() < 0.5 ? [110, 110, 118] : [140, 140, 148];
        px(g, x, y, col[0], col[1], col[2]);
      }
    }
    px(g, 2, 1, 165, 165, 172);
    return c;
  })();
  // цветок
  spr.flower = (() => {
    const c = document.createElement('canvas'); c.width = 6; c.height = 6;
    const g = c.getContext('2d');
    px(g, 2, 5, 70, 120, 50); px(g, 2, 4, 70, 120, 50);
    const cols = [[240, 210, 90], [235, 130, 140], [140, 160, 240]];
    const col = cols[Math.floor(r() * 3)];
    px(g, 2, 3, col[0], col[1], col[2]); px(g, 1, 3, col[0], col[1], col[2]);
    px(g, 3, 3, col[0], col[1], col[2]); px(g, 2, 2, col[0], col[1], col[2]);
    return c;
  })();
  // пень
  spr.stump = (() => {
    const c = document.createElement('canvas'); c.width = 6; c.height = 4;
    const g = c.getContext('2d');
    for (let y = 1; y < 4; y++) for (let x = 0; x < 6; x++)
      if (y < 2 || (x > 0 && x < 5)) px(g, x, y, 110, 80, 50);
    px(g, 1, 0, 150, 116, 76); px(g, 2, 0, 150, 116, 76); px(g, 3, 0, 150, 116, 76);
    px(g, 2, 1, 120, 90, 58);
    return c;
  })();
  // хижина
  spr.hut = (() => {
    const c = document.createElement('canvas'); c.width = 16; c.height = 14;
    const g = c.getContext('2d');
    for (let y = 7; y < 13; y++) for (let x = 2; x < 14; x++) {
      const col = (x + y) % 2 ? [150, 110, 70] : [135, 98, 62];
      px(g, x, y, col[0], col[1], col[2]);
    }
    for (let row = 0; row < 7; row++) {
      for (let x = 1 + row; x < 15 - row; x++) {
        const col = row % 2 ? [96, 62, 44] : [118, 78, 52];
        px(g, x, row, col[0], col[1], col[2]);
      }
    }
    px(g, 4, 9, 40, 30, 24); px(g, 5, 9, 40, 30, 24);
    px(g, 4, 10, 40, 30, 24); px(g, 5, 10, 40, 30, 24);
    for (let y = 9; y < 13; y++) px(g, 11, y, 62, 44, 30);
    spr.hutWindow = { x: 4, y: 9, w: 2, h: 2 };
    return c;
  })();
  // костёр
  spr.campfire = (() => {
    const c = document.createElement('canvas'); c.width = 10; c.height = 10;
    const g = c.getContext('2d');
    g.fillStyle = 'rgb(96,68,40)'; g.fillRect(1, 7, 8, 2);
    g.fillStyle = 'rgb(120,86,50)'; g.fillRect(2, 6, 6, 1);
    px(g, 0, 8, 110, 110, 118); px(g, 9, 8, 110, 110, 118);
    return c;
  })();
  // ферма (пшеница), 16×10, стадии 1..3
  spr.farm = [null, makeFarm(1, r), makeFarm(2, r), makeFarm(3, r)];
  function makeFarm(stage, r) {
    const c = document.createElement('canvas'); c.width = 16; c.height = 10;
    const g = c.getContext('2d');
    // грядки
    for (let y = 0; y < 10; y++) for (let x = 0; x < 16; x++) {
      const col = (y % 3 === 2) ? [86, 62, 40] : [104, 78, 50];
      px(g, x, y, col[0], col[1], col[2]);
    }
    // ростки
    for (let row = 0; row < 3; row++) {
      for (let k = 0; k < 5; k++) {
        const x = k * 3 + 1, y = row * 3 + 1;
        if (stage === 1) { px(g, x, y, 90, 160, 60); px(g, x, y - 1, 110, 180, 70); }
        else if (stage === 2) { px(g, x, y, 110, 170, 60); px(g, x, y - 1, 130, 190, 80); px(g, x, y - 2, 150, 200, 90); }
        else { px(g, x, y, 190, 170, 60); px(g, x, y - 1, 210, 180, 70); px(g, x, y - 2, 230, 200, 80); px(g, x, y - 3, 240, 210, 90); }
      }
    }
    return c;
  }
  // могилка
  spr.grave = (() => {
    const c = document.createElement('canvas'); c.width = 6; c.height = 7;
    const g = c.getContext('2d');
    for (let y = 1; y < 6; y++) px(g, 2, y, 150, 150, 158);
    px(g, 3, 1, 150, 150, 158); px(g, 4, 1, 150, 150, 158);
    px(g, 1, 6, 110, 110, 118); px(g, 2, 6, 110, 110, 118); px(g, 3, 6, 110, 110, 118); px(g, 4, 6, 110, 110, 118);
    px(g, 2, 2, 90, 90, 98);
    return c;
  })();
  // кролик (2 кадра)
  spr.rabbit = (() => {
    const frames = [];
    for (let f = 0; f < 2; f++) {
      const c = document.createElement('canvas'); c.width = 7; c.height = 7;
      const g = c.getContext('2d');
      g.fillStyle = 'rgb(235,230,220)'; g.fillRect(1, 2 + f, 5, 4);           // тело
      g.fillRect(2, 0 + f, 1, 2); g.fillRect(4, 0 + f, 1, 2);                  // уши
      px(g, 5, 3, 20, 20, 20);                                                  // глаз
      px(g, 0, 5 + f, 200, 195, 185); px(g, 6, 5 + f, 200, 195, 185);          // лапки
      px(g, 2, 2 + f, 220, 215, 205);
      frames.push(c);
    }
    return frames;
  })();
  // волк (2 кадра)
  spr.wolf = (() => {
    const frames = [];
    for (let f = 0; f < 2; f++) {
      const c = document.createElement('canvas'); c.width = 11; c.height = 7;
      const g = c.getContext('2d');
      g.fillStyle = 'rgb(120,118,125)'; g.fillRect(1, 2, 8, 4);               // тело
      g.fillRect(8, 0, 2, 3); g.fillRect(9, 1, 1, 2);                          // голова+морда
      px(g, 7, 0, 120, 118, 125); px(g, 8, 0, 120, 118, 125);                  // уши
      px(g, 10, 1, 30, 30, 32);                                                 // нос
      px(g, 9, 1, 200, 60, 60);                                                  // глаз
      g.fillStyle = 'rgb(100,98,105)';
      g.fillRect(2 + f, 5, 2, 2); g.fillRect(6 - f, 5, 2, 2);                  // лапы
      px(g, 0, 2 + f, 100, 98, 105);                                            // хвост
      frames.push(c);
    }
    return frames;
  })();
  // слайма (2 кадра — пружинит)
  spr.slime = (() => {
    const frames = [];
    for (let f = 0; f < 2; f++) {
      const c = document.createElement('canvas'); c.width = 8; c.height = 8;
      const g = c.getContext('2d');
      const hgt = f ? 6 : 7, y0 = 8 - hgt;
      for (let y = y0; y < 8; y++) for (let x = 0; x < 8; x++) {
        if (Math.abs(x - 3.5) < 4 - (y - y0) * 0.3) {
          const col = y < y0 + 2 ? [110, 200, 90] : [70, 160, 60];
          px(g, x, y, col[0], col[1], col[2]);
        }
      }
      px(g, 2, y0 + 2, 20, 20, 20); px(g, 5, y0 + 2, 20, 20, 20);              // глаза
      frames.push(c);
    }
    return frames;
  })();
  // персонажи
  const HAIRS = [[62, 38, 24], [30, 24, 20], [150, 100, 50], [90, 60, 30], [40, 44, 90], [110, 40, 44]];
  const SHIRTS = [[170, 60, 60], [60, 90, 170], [80, 140, 80], [170, 140, 60], [140, 80, 150], [90, 90, 100]];
  const PANTS = [[50, 52, 70], [70, 50, 40], [40, 60, 50]];
  const SKINS = [[238, 190, 150], [220, 170, 130], [196, 148, 108]];
  spr.bodies = [];
  for (const hair of HAIRS) for (const shirt of SHIRTS)
    spr.bodies.push({ hair, shirt, pants: PANTS[Math.floor(r() * 3)], skin: SKINS[Math.floor(r() * 3)] });
  makeVillagerSprites();
}

function makeVillagerSpriteSet(body) {
  const frames = [];
  for (let f = 0; f < 2; f++) {
    const c = document.createElement('canvas'); c.width = 8; c.height = 14;
    const g = c.getContext('2d');
    const { hair, shirt, pants, skin } = body;
    g.fillStyle = `rgb(${hair[0]},${hair[1]},${hair[2]})`;
    g.fillRect(1, 0, 6, 2); g.fillRect(0, 1, 8, 2);
    g.fillStyle = `rgb(${skin[0]},${skin[1]},${skin[2]})`;
    g.fillRect(1, 3, 6, 3);
    px(g, 2, 4, 30, 24, 22); px(g, 5, 4, 30, 24, 22);
    g.fillStyle = `rgb(${shirt[0]},${shirt[1]},${shirt[2]})`;
    g.fillRect(1, 6, 6, 4);
    px(g, 0, 6, shirt[0], shirt[1], shirt[2]); px(g, 7, 6, shirt[0], shirt[1], shirt[2]);
    px(g, 0, 7, skin[0], skin[1], skin[2]); px(g, 7, 7, skin[0], skin[1], skin[2]);
    g.fillStyle = `rgb(${pants[0]},${pants[1]},${pants[2]})`;
    g.fillRect(2, 10, 4, 2);
    g.fillStyle = `rgb(${pants[0]},${pants[1]},${pants[2]})`;
    if (f === 0) { g.fillRect(2, 12, 2, 2); g.fillRect(5, 12, 1, 2); }
    else { g.fillRect(3, 12, 1, 2); g.fillRect(4, 12, 2, 2); }
    frames.push(c);
  }
  return frames;
}
function makeVillagerSprites() {
  spr.villagerFrames = spr.bodies.map(b => makeVillagerSpriteSet(b));
  spr.villagerFlip = spr.villagerFrames.map(f => f.map(c => {
    const c2 = document.createElement('canvas'); c2.width = 8; c2.height = 14;
    const g = c2.getContext('2d');
    g.translate(8, 0); g.scale(-1, 1); g.drawImage(c, 0, 0);
    return c2;
  }));
}

// ── Канвас карты ─────────────────────────────────────────────────
let mapCanvas = null;
function renderMapCanvas() {
  mapCanvas = document.createElement('canvas');
  mapCanvas.width = MAP_W; mapCanvas.height = MAP_H;
  const g = mapCanvas.getContext('2d');
  const r = mulberry32(seed ^ 0x9e37);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const t = world[key(x, y)];
      const v = Math.floor(r() * 4);
      g.drawImage(tileTex[t][v], x * TILE, y * TILE);
      if (t >= 2 && t <= 4) {
        if (inb(x, y - 1) && world[key(x, y - 1)] <= 1) {
          g.fillStyle = 'rgba(220,220,180,0.25)'; g.fillRect(x * TILE, y * TILE, TILE, 1);
        }
      }
    }
}

// ── Персонажи ─────────────────────────────────────────────────────
const NAMES = ['Аскар', 'Дана', 'Марат', 'Айгерим', 'Тимур', 'Мадина', 'Арман', 'Камила', 'Ерлан', 'Сабина', 'Нурлан', 'Алия', 'Данияр', 'Жанна', 'Кайрат', 'Дина', 'Бекзат', 'Асель', 'Ислам', 'Гульнара'];
const TRAITS = [
  { k: 'hardworking', label: 'трудолюбивый' },
  { k: 'brave', label: 'храбрый' },
  { k: 'sociable', label: 'общительный' },
  { k: 'curious', label: 'любопытный' },
  { k: 'dreamer', label: 'мечтательный' },
  { k: 'kind', label: 'добрый' }
];
const THOUGHTS = {
  chop: ['Дерево само себя не срубит.', 'Тук-тук-тук… делу время.', 'Настрою дров на всю деревню!', 'Хорошая древесина, крепкая.'],
  forage: ['Ягодки, сладкие как мёд!', 'Вот и кустик со спелыми ягодами.', 'Соберу-ка ягод на всех.'],
  harvest: ['Пшеница созрела, урожай!', 'Хлеб будет!', 'Урожай удался на славу.'],
  eat: ['Ням… вот теперь можно и поработать.', 'Какая вкуснотища!', 'Сытый житель — счастливый житель.'],
  sleep: ['Какая звёздная ночь…', 'Спать-спать-спать…', 'Завтра будет новый день.', 'Дым костра убаюкивает…'],
  social: ['Сто лет не виделись!', 'Слышал, скоро новый дом строим?', 'Болтать у костра — лучшее время.'],
  deposit: ['Вклад в общее дело!', 'Дрова в общую кучу — так честно.'],
  wander: ['Пойду посмотрю, что там.', 'Интересно, что за холмом?', 'Прогулка ещё никому не мешала.', 'Мир большой, надо всё обойти.'],
  idle: ['Сегодня хороший день.', 'Чем бы заняться?', 'Птички поют… красота.'],
  craft: ['Нужен топор — сделаю топор.', 'Хороший инструмент — половина дела.', 'Кузнечное дело по плечу каждому… наверное.'],
  fight: ['За деревню!', 'А ну, тварь, отступай!', 'Не сегодня, слайма!', 'Костром клянусь, ты не пройдёшь!'],
  flee: ['Спасайся кто может!', 'Отступаем!', 'Надо в укрытие!'],
  hunt: ['Тише… кролик близко.', 'Ужин сам бежит в руки.'],
  greet: ['Новый человек! Надо познакомиться.', 'О, к нам пополнение!'],
  nightDream: ['Что там, за туманом?..', 'Звёзды… интересно, из чего они?'],
  child: ['Когда я вырасту, стану строителем!', 'Ух, большой мир!', 'Мама сказала не уходить далеко…']
};

function makeVillager(x, y) {
  const bodyIdx = Math.floor(rng() * spr.bodies.length);
  const usedNames = villagers.map(v => v.name);
  const freeNames = NAMES.filter(n => !usedNames.includes(n));
  const name = freeNames.length ? freeNames[Math.floor(rng() * freeNames.length)] : 'Житель ' + nextId;
  const pool = [...TRAITS];
  const traits = [];
  for (let i = 0; i < 2 && pool.length; i++)
    traits.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return {
    id: nextId++, name, bodyIdx, traits,
    x, y, path: null, pathIdx: 0, facing: 1,
    state: 'idle', stateT: 0, workT: 0, targetObj: null, targetVil: null,
    carry: { wood: 0, berries: 0 },
    needs: { hunger: 70 + rng() * 30, energy: 70 + rng() * 30, social: 50 + rng() * 40 },
    skill: { chop: 1, forage: 1, combat: 1 },
    hp: 20, tool: null,
    isChild: false, growAt: 0,
    thought: '', thoughtUntil: 0, thoughts: [],
    home: null, decideT: rng() * 2,
    threatT: 0, atkT: 0, fightId: 0, repathT: 0, huntId: 0
  };
}
function makeChild(a, b) {
  const v = makeVillager(a.x, a.y);
  v.name = 'Малыш ' + a.name[0] + (b.name[0] || '');
  v.traits = [a.traits[Math.floor(rng() * 2)], b.traits[Math.floor(rng() * 2)]];
  v.bodyIdx = rng() < 0.5 ? a.bodyIdx : b.bodyIdx;
  v.isChild = true;
  v.growAt = simTime + DAY_LEN * 1.2;
  v.skill = { chop: 0.4, forage: 0.4, combat: 0.4 };
  return v;
}

function hasTrait(v, k) { return v.traits.some(t => t.k === k); }
function think(v, text) {
  v.thought = text;
  v.thoughtUntil = simTime + 5;
  v.thoughts.unshift({ t: simTime, text });
  if (v.thoughts.length > 8) v.thoughts.pop();
}

// ── A* ───────────────────────────────────────────────────────────
class Heap {
  constructor() { this.a = []; }
  push(n, f) { this.a.push({ n, f }); let i = this.a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (this.a[p].f <= this.a[i].f) break; const tmp = this.a[p]; this.a[p] = this.a[i]; this.a[i] = tmp; i = p; } }
  pop() { const top = this.a[0]; const last = this.a.pop(); if (this.a.length) { this.a[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < this.a.length && this.a[l].f < this.a[m].f) m = l; if (r < this.a.length && this.a[r].f < this.a[m].f) m = r; if (m === i) break; const tmp = this.a[m]; this.a[m] = this.a[i]; this.a[i] = tmp; i = m; } } return top ? top.n : null; }
  get size() { return this.a.length; }
}
function astar(sx, sy, tx, ty) {
  if (!inb(tx, ty) || !walkable(tx, ty)) return null;
  sx = Math.floor(sx); sy = Math.floor(sy);
  if (sx === tx && sy === ty) return [];
  const open = new Heap();
  const g = new Map(), came = new Map();
  const startK = key(sx, sy);
  g.set(startK, 0);
  open.push({ x: sx, y: sy, k: startK }, 0);
  const closed = new Set();
  let iter = 0;
  while (open.size && iter++ < 4000) {
    const cur = open.pop();
    if (closed.has(cur.k)) continue;
    closed.add(cur.k);
    if (cur.x === tx && cur.y === ty) {
      const path = [];
      let k = cur.k;
      while (k !== startK) {
        path.push({ x: k % W, y: Math.floor(k / W) });
        k = came.get(k);
      }
      path.reverse();
      return path;
    }
    const cg = g.get(cur.k);
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + d[0], ny = cur.y + d[1];
      if (!walkable(nx, ny)) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const ng = (cg === undefined ? 0 : cg) + 1;
      if (ng < (g.has(nk) ? g.get(nk) : Infinity)) {
        g.set(nk, ng); came.set(nk, cur.k);
        open.push({ x: nx, y: ny, k: nk }, ng + Math.abs(nx - tx) + Math.abs(ny - ty));
      }
    }
  }
  return null;
}
function approachTile(v, ox, oy) {
  if (walkable(ox, oy)) return { x: ox, y: oy };
  let best = null, bd = Infinity;
  for (const d of [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const x = ox + d[0], y = oy + d[1];
    if (!walkable(x, y)) continue;
    const dd = dist2(v.x, v.y, x, y);
    if (dd < bd) { bd = dd; best = { x, y }; }
  }
  return best;
}
function gotoObj(v, o) {
  const t = approachTile(v, o.x, o.y);
  if (!t) return false;
  v.path = astar(v.x, v.y, t.x, t.y);
  v.pathIdx = 0;
  return !!v.path || (Math.floor(v.x) === t.x && Math.floor(v.y) === t.y);
}
function findNearestObj(v, types, extra) {
  let best = null, bd = Infinity;
  for (const o of objects) {
    if (!types.includes(o.type)) continue;
    if (o.regrow > simTime) continue;
    if (o.type === 'bush' && o.depleted) continue;
    if (extra && !extra(o)) continue;
    const d = dist2(v.x, v.y, o.x, o.y);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

// ── Время, погода ────────────────────────────────────────────────
function phase() { return (simTime % DAY_LEN) / DAY_LEN; }
function isNight() { const p = phase(); return p > 0.65 || p < 0.1; }
function nightAmount() {
  const p = phase();
  let n = 0;
  if (p > 0.58) n = Math.min(1, (p - 0.58) / 0.14);
  if (p < 0.2) n = Math.max(n, 1 - p / 0.2);
  return n;
}
function rainMult() { return weather.rain ? 2 : 1; }

// ── Решения ──────────────────────────────────────────────────────
function nearestMonster(v, range) {
  let best = null, bd = range * range;
  for (const m of monsters) {
    const d = dist2(m.x, m.y, v.x, v.y);
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}
function decide(v) {
  const night = isNight();
  const n = v.needs;
  // 1. угроза — выжить важнее всего
  const threat = nearestMonster(v, v.isChild ? 7 : 5);
  if (threat) {
    const braveEnough = !v.isChild && (hasTrait(v, 'brave') ? v.hp > 8 : v.hp > 12 || v.tool === 'spear');
    if (braveEnough) startFight(v, threat);
    else startFlee(v);
    return;
  }
  if (v.isChild) { decideChild(v, night, n); return; }
  if (pendingBuild && !pendingBuild.assigned && !night) { startBuild(v); return; }
  if (n.hunger < 32) { startEat(v); return; }
  if (n.energy < 22 || (night && n.energy < 70)) { startSleep(v); return; }
  if (v.carry.wood + v.carry.berries >= 6) { startDeposit(v); return; }
  if (n.social < 30 && !night) {
    const partner = villagers.find(o => o !== v && o !== v.targetVil && !['sleep', 'social', 'flee', 'hide'].includes(o.state) && o.needs.social < 60);
    if (partner) { startSocial(v, partner); return; }
  }
  // ферма созрела — урожай важнее всего из работы
  const readyFarm = farms.find(f => f.stage >= 3);
  if (readyFarm && !night) { startHarvest(v, readyFarm); return; }
  // еда кончается — фуражируем / охотимся
  if (stocks.berries < 8 && !night) {
    const b = findNearestObj(v, ['bush']);
    if (b) { startForage(v, b); return; }
    const rb = nearestAnimal(v, 'rabbit', 9);
    if (rb) { startHunt(v, rb); return; }
  }
  // перед рубкой — скрафти топор
  if (!v.tool && stocks.wood >= 8 && !night) { startCraft(v, 'axe'); return; }
  const t = findNearestObj(v, ['tree', 'pine']);
  if (t && !night) { startChop(v, t); return; }
  if (night && hasTrait(v, 'dreamer') && rng() < 0.5) { think(v, pick(THOUGHTS.nightDream)); startWander(v); return; }
  startWander(v);
}
function decideChild(v, night, n) {
  if (n.hunger < 35) { startEat(v); return; }
  if (n.energy < 30 || night) { startSleep(v); return; }
  if (v.carry.berries > 0) { startDeposit(v); return; }
  const b = findNearestObj(v, ['bush']);
  if (b && !night) { startForage(v, b); return; }
  if (rng() < 0.3) think(v, pick(THOUGHTS.child));
  startWander(v);
}
function pick(arr) { return arr[Math.floor(rng() * arr.length)]; }

function startChop(v, o) {
  if (!gotoObj(v, o)) { startWander(v); return; }
  v.state = 'goto_chop'; v.targetObj = o;
  think(v, pick(THOUGHTS.chop));
}
function startForage(v, o) {
  if (!gotoObj(v, o)) { startWander(v); return; }
  v.state = 'goto_forage'; v.targetObj = o;
  think(v, pick(THOUGHTS.forage));
}
function startHarvest(v, o) {
  if (!gotoObj(v, o)) { startWander(v); return; }
  v.state = 'goto_harvest'; v.targetObj = o;
  think(v, pick(THOUGHTS.harvest));
}
function startHunt(v, a) {
  v.state = 'hunt'; v.huntId = a.id;
  think(v, pick(THOUGHTS.hunt));
}
function startCraft(v, kind) {
  const t = approachTile(v, campfire.x, campfire.y) || { x: campfire.x, y: campfire.y + 1 };
  v.path = astar(v.x, v.y, t.x, t.y); v.pathIdx = 0;
  v.state = 'goto_craft'; v.craftKind = kind;
  think(v, pick(THOUGHTS.craft));
}
function startDeposit(v) {
  const t = approachTile(v, campfire.x, campfire.y) || { x: campfire.x, y: campfire.y + 1 };
  v.path = astar(v.x, v.y, t.x, t.y); v.pathIdx = 0;
  v.state = 'goto_deposit';
  think(v, pick(THOUGHTS.deposit));
}
function startEat(v) {
  if (stocks.berries > 0) {
    const t = approachTile(v, campfire.x, campfire.y) || { x: campfire.x, y: campfire.y + 1 };
    v.path = astar(v.x, v.y, t.x, t.y); v.pathIdx = 0;
    v.state = 'goto_eat';
    think(v, 'Проголодался… пойду к костру.');
  } else {
    const b = findNearestObj(v, ['bush']);
    if (b) { startForage(v, b); v.eatIntent = true; }
    else {
      const rb = nearestAnimal(v, 'rabbit', 10);
      if (rb && !v.isChild) { startHunt(v, rb); v.eatIntent = true; }
      else { v.state = 'idle'; v.decideT = 3; think(v, 'В деревне пусто… надо искать еду.'); }
    }
  }
}
function startSleep(v) {
  const home = huts.length ? huts[v.id % huts.length] : campfire;
  const t = approachTile(v, home.x, home.y) || { x: home.x, y: home.y + 1 };
  v.path = astar(v.x, v.y, t.x, t.y); v.pathIdx = 0;
  v.state = 'goto_sleep';
  think(v, pick(THOUGHTS.sleep));
}
function startSocial(v, partner) {
  v.state = 'goto_social'; v.targetVil = partner;
  if (partner.state === 'idle' || partner.state === 'wander') {
    partner.state = 'goto_social'; partner.targetVil = v;
  }
  think(v, pick(THOUGHTS.social));
}
function startWander(v) {
  for (let tries = 0; tries < 10; tries++) {
    const x = Math.floor(v.x + (rng() * 21) - 10), y = Math.floor(v.y + (rng() * 21) - 10);
    if (walkable(x, y)) {
      const p = astar(v.x, v.y, x, y);
      if (p) { v.path = p; v.pathIdx = 0; v.state = 'wander'; think(v, pick(THOUGHTS.wander)); return; }
    }
  }
  v.state = 'idle'; v.decideT = 1 + rng() * 2;
  if (rng() < 0.4) think(v, pick(THOUGHTS.idle));
}
function startBuild(v) {
  pendingBuild.assigned = v;
  v.path = astar(v.x, v.y, pendingBuild.x, pendingBuild.y); v.pathIdx = 0;
  v.state = 'goto_build';
  think(v, pendingBuild.kind === 'farm' ? 'Вспашу поле — хлеб сам себя не посадит!' : 'Строим новый дом! За работу.');
}
function startFight(v, m) {
  v.state = 'fight'; v.fightId = m.id; v.repathT = 0;
  think(v, pick(THOUGHTS.fight));
}
function startFlee(v) {
  const home = huts.length ? huts[v.id % huts.length] : campfire;
  const t = approachTile(v, home.x, home.y) || { x: home.x, y: home.y + 1 };
  v.path = astar(v.x, v.y, t.x, t.y); v.pathIdx = 0;
  v.state = 'flee';
  think(v, pick(THOUGHTS.flee));
}
function nearestAnimal(v, kind, range) {
  let best = null, bd = range * range;
  for (const a of animals) {
    if (a.kind !== kind || a.hp <= 0) continue;
    const d = dist2(a.x, a.y, v.x, v.y);
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}

// ── Симуляция ────────────────────────────────────────────────────
function updateSim(dt) {
  simTime += dt;
  const p = phase();
  // погода
  weather.t -= dt;
  if (weather.t <= 0) {
    weather.rain = !weather.rain;
    if (weather.rain) {
      weather.t = 40 + rng() * 60;
      SIM.rains++;
      logEvent('🌧', 'Пошёл дождь. Растения растут быстрее!');
    } else weather.t = 60 + rng() * 160;
  }
  if (weather.rain && rng() < 0.002) {
    weather.bolt = 0.4;
    if (rng() < 0.3) logEvent('⚡', 'Гром гремит по холмам!');
  }
  if (weather.bolt > 0) weather.bolt = Math.max(0, weather.bolt - dt);

  // фазы суток
  if (lastPhase < 0.65 && p >= 0.65) onNightfall();
  if (lastPhase < 0.12 && p >= 0.12) onMorning();
  lastPhase = p;

  // появление новых жителей по нарубленному
  if (settlersSpawned < settlersThresholds.length &&
      totalWood >= settlersThresholds[settlersSpawned] && !isNight()) {
    arriveSettler();
  }

  // план стройки
  if (!pendingBuild && !isNight()) {
    const wantFarm = stocks.berries < 25 && farms.length < 4 && stocks.wood >= 15;
    const wantHut = stocks.wood >= 25 && huts.length < 9;
    if (wantFarm || wantHut) {
      const kind = wantFarm ? 'farm' : 'hut';
      const spot = findBuildSpot(kind);
      if (spot) pendingBuild = { kind, x: spot.x, y: spot.y, assigned: null };
    }
  }

  // жители
  for (const v of [...villagers]) updateVillager(v, dt);
  // животные
  for (const a of [...animals]) updateAnimal(a, dt);
  // монстры
  for (const m of [...monsters]) updateMonster(m, dt);

  // регенерация
  for (const o of objects) {
    if (o.type === 'bush' && o.depleted && o.regrowAt && simTime >= o.regrowAt) {
      o.depleted = false; o.regrowAt = 0;
    }
  }
  processRegrow();
  // рост пшеницы
  for (const f of farms) {
    if (f.stage < 3 && simTime >= f.growAt) {
      f.stage++;
      f.growAt = simTime + 60 / rainMult();
    }
  }
}

function onNightfall() {
  const day = Math.floor(simTime / DAY_LEN) + 1;
  const count = Math.min(4, Math.ceil(villagers.length / 4) + (day > 6 ? 1 : 0));
  for (let i = 0; i < count; i++) {
    const p = randWalkable(22);
    monsters.push({
      id: nextId++, kind: 'slime', x: p.x, y: p.y,
      hp: 10 + day, maxHp: 10 + day, dmg: 2 + Math.min(3, Math.floor(day / 4)),
      state: 'wander', t: 0, targetId: 0, atkT: 0, facing: 1, animT: 0
    });
  }
  SIM.monsterWaves += count;
  logEvent('👾', `Ночь. Из тьмы выползли слаймы (${count})!`);
  if (rng() < 0.4) logEvent('🐺', 'Волки воют в лесу…');
  for (const v of villagers)
    if (hasTrait(v, 'dreamer') && v.state !== 'sleep') think(v, pick(THOUGHTS.nightDream));
}

function onMorning() {
  // дети растут
  for (const v of [...villagers]) {
    if (v.isChild && simTime >= v.growAt) {
      v.isChild = false;
      v.name = v.name.replace('Малыш ', '');
      logEvent('🧒', `${v.name} вырос и теперь полноправный житель!`);
    }
  }
  // пополнение природы
  let rabbits = animals.filter(a => a.kind === 'rabbit' && a.hp > 0).length;
  if (rabbits < 8) {
    const p = randWalkable(8);
    animals.push({ id: nextId++, kind: 'rabbit', x: p.x, y: p.y, hp: 5, state: 'idle', t: 1, dirX: 0, dirY: 0, facing: 1, animT: 0 });
  }
  // рождение: еда есть, дома есть, любовь есть
  const adults = villagers.filter(v => !v.isChild);
  if (adults.length >= 2 && stocks.berries >= 15 && huts.length >= 4 && rng() < 0.5 && villagers.length < 16) {
    const a = adults[Math.floor(rng() * adults.length)];
    let b = adults[Math.floor(rng() * adults.length)];
    if (b === a) b = adults[(adults.indexOf(a) + 1) % adults.length];
    const child = makeChild(a, b);
    villagers.push(child);
    stocks.berries -= 10;
    SIM.births++;
    think(a, 'У нас родился малыш!');
    logEvent('👶', `У ${a.name} и ${b.name} родился ребёнок! Деревня растёт.`);
  }
  // подселение после потерь
  if (villagers.length < huts.length && rng() < 0.35) arriveSettler();
}

function arriveSettler() {
  let sx = -1, sy = -1;
  for (let tries = 0; tries < 200; tries++) {
    const x = Math.floor(rng() * W), y = rng() < 0.5 ? 1 : H - 2;
    if (walkable(x, y)) { sx = x; sy = y; break; }
  }
  if (sx >= 0) {
    const nv = makeVillager(sx + 0.5, sy + 0.5);
    nv.state = 'goto_camp';
    nv.path = astar(sx, sy, campfire.x, campfire.y); nv.pathIdx = 0;
    villagers.push(nv);
    think(nv, 'Говорят, тут хорошие люди живут.');
    logEvent('🎉', `${nv.name} пришёл в деревню! Теперь нас ${villagers.length}.`);
    settlersSpawned++;
    for (const v of villagers)
      if (v !== nv && hasTrait(v, 'curious')) think(v, pick(THOUGHTS.greet));
  }
}

function findBuildSpot(kind) {
  for (let r = 2; r <= 7; r++) {
    for (let a = 0; a < 24; a++) {
      const ang = a / 24 * Math.PI * 2;
      const x = Math.round(campfire.x + Math.cos(ang) * r);
      const y = Math.round(campfire.y + Math.sin(ang) * r);
      if (kind === 'farm') {
        if (walkable(x, y) && walkable(x + 1, y) && dist2(x, y, campfire.x, campfire.y) >= 9) return { x, y };
      } else {
        if (walkable(x, y) && walkable(x, y + 1) && dist2(x, y, campfire.x, campfire.y) >= 4) return { x, y };
      }
    }
  }
  return null;
}

// прямолинейное движение со скольжением вдоль препятствий
function steer(e, tx, ty, speed, dt) {
  const dx = tx - e.x, dy = ty - e.y;
  const d = Math.hypot(dx, dy) || 1;
  if (dx !== 0) e.facing = dx > 0 ? 1 : -1;
  const nx = e.x + dx / d * speed * dt, ny = e.y + dy / d * speed * dt;
  if (walkable(Math.floor(nx), Math.floor(e.y))) e.x = nx;
  if (walkable(Math.floor(e.x), Math.floor(ny))) e.y = ny;
  return d;
}

function updateAnimal(a, dt) {
  if (a.hp <= 0) return;
  a.t -= dt;
  a.animT += dt;
  if (a.kind === 'rabbit') {
    // паника от хищника/охотника
    let threat = null, td = 5 * 5;
    for (const w of animals) if (w.kind === 'wolf' && w.hp > 0) {
      const d = dist2(w.x, w.y, a.x, a.y);
      if (d < td) { td = d; threat = w; }
    }
    for (const v of villagers) {
      if (v.huntId && v.state === 'hunt') {
        const d = dist2(v.x, v.y, a.x, a.y);
        if (d < td) { td = d; threat = v; }
      }
    }
    if (threat) {
      const away = { x: a.x + (a.x - threat.x) * 2, y: a.y + (a.y - threat.y) * 2 };
      steer(a, away.x, away.y, 5.5, dt);
      a.state = 'flee';
      return;
    }
    a.state = 'idle';
    if (a.t <= 0) {
      a.t = 0.8 + rng() * 1.5;
      a.dirX = a.x + (rng() * 6 - 3);
      a.dirY = a.y + (rng() * 6 - 3);
    }
    steer(a, a.dirX, a.dirY, 2.2, dt);
  } else if (a.kind === 'wolf') {
    // охота на кролика
    if (a.preyId) {
      const prey = animals.find(x => x.id === a.preyId && x.hp > 0);
      if (!prey) { a.preyId = 0; a.state = 'idle'; a.t = 2; }
      else {
        const d = steer(a, prey.x, prey.y, 3.4, dt);
        if (d < 0.8) {
          prey.hp = 0;
          a.preyId = 0; a.state = 'idle'; a.t = 6;
          if (rng() < 0.3) logEvent('🐺', 'Волк поймал кролика. Такова природа.');
        }
        return;
      }
    } else {
      if (a.t <= 0) {
        a.t = 2 + rng() * 3;
        let prey = null, bd = 7 * 7;
        for (const rb of animals) {
          if (rb.kind !== 'rabbit' || rb.hp <= 0) continue;
          const d = dist2(rb.x, rb.y, a.x, a.y);
          if (d < bd) { bd = d; prey = rb; }
        }
        if (prey) a.preyId = prey.id;
        else { a.dirX = a.x + (rng() * 10 - 5); a.dirY = a.y + (rng() * 10 - 5); }
      }
      if (a.state !== 'idle' || true) steer(a, a.dirX || a.x, a.dirY || a.y, 0.9, dt);
    }
  }
}

function updateMonster(m, dt) {
  m.animT += dt;
  // на солнце слаймы тают
  if (!isNight()) {
    m.hp -= 10 * dt;
    if (m.hp <= 0) {
      killMonster(m, 'растаял на солнце');
      return;
    }
  }
  // цель: ближайший житель (кроме спрятавшихся)
  let target = null, bd = 9 * 9;
  for (const v of villagers) {
    if (v.state === 'hide' || v.state === 'sleep' && isNight() && false) continue;
    if (v.state === 'hide') continue;
    const d = dist2(v.x, v.y, m.x, m.y);
    if (d < bd) { bd = d; target = v; }
  }
  if (target) {
    const d = steer(m, target.x, target.y, 1.55, dt);
    if (d < 1.15) {
      m.atkT -= dt;
      if (m.atkT <= 0) {
        m.atkT = 1.2;
        target.hp -= m.dmg;
        if (rng() < 0.3) think(target, 'Ай! Эта тварь кусается!');
        if (target.hp <= 0) killVillager(target, m);
      }
    }
  } else {
    // бредут к деревне
    m.t -= dt;
    if (m.t <= 0) {
      m.t = 3 + rng() * 3;
      m.dirX = campfire.x + (rng() * 16 - 8);
      m.dirY = campfire.y + (rng() * 16 - 8);
    }
    steer(m, m.dirX, m.dirY, 0.7, dt);
  }
}

function killMonster(m, how) {
  const i = monsters.indexOf(m);
  if (i >= 0) monsters.splice(i, 1);
  SIM.monsterKills++;
  if (how === 'растаял на солнце') {
    if (rng() < 0.3) logEvent('☀️', 'Слайма растаяла под лучами солнца.');
  } else {
    logEvent('⚔️', `Слайма побеждена (${how})!`);
  }
}
function killVillager(v, by) {
  const i = villagers.indexOf(v);
  if (i >= 0) villagers.splice(i, 1);
  if (selected === v) selected = null;
  addObject('grave', Math.floor(v.x), Math.floor(v.y));
  SIM.deaths++;
  logEvent('😢', `${v.name} погиб${v.isChild ? '' : ' как герой'}, защищая деревню. Деревня скорбит…`);
}

function updateVillager(v, dt) {
  const n = v.needs;
  const working = ['chop', 'forage', 'goto_chop', 'goto_forage', 'goto_build', 'build', 'goto_harvest', 'harvest'].includes(v.state);
  n.hunger = Math.max(0, n.hunger - dt * 0.09);
  n.energy = Math.max(0, n.energy - dt * (working ? 0.055 : v.state === 'sleep' ? -0.14 : 0.03));
  n.social = Math.max(0, n.social - dt * (v.state === 'social' ? -0.2 : 0.035));
  if (n.hunger < 12) n.energy = Math.max(0, n.energy - dt * 0.05);
  // реген HP
  if (v.state === 'sleep' || v.state === 'eat') v.hp = Math.min(20, v.hp + 0.8 * dt);
  else if (v.state === 'idle' && dist(v.x, v.y, campfire.x, campfire.y) < 3) v.hp = Math.min(20, v.hp + 0.3 * dt);

  // угроза каждые полсекунды — прерывает всё
  v.threatT -= dt;
  if (v.threatT <= 0 && !['fight', 'flee'].includes(v.state)) {
    v.threatT = 0.5;
    const threat = nearestMonster(v, v.isChild ? 7 : 4.5);
    if (threat) {
      v.path = null;
      decide(v);
      return;
    }
  }

  if (v.state === 'sleep') {
    // тревога будит: слайма рядом — просыпаемся и действуем
    const threat = nearestMonster(v, 5);
    if (threat) {
      v.path = null;
      decide(v);
      return;
    }
    if (phase() < 0.15 || phase() > 0.9 || n.hunger < 15) {
      v.state = 'idle'; v.decideT = 0.5;
      think(v, 'Доброе утро!');
    }
    return;
  }

  // движение по пути
  if (v.path && v.pathIdx < v.path.length) {
    const node = v.path[v.pathIdx];
    const tx = node.x + 0.5, ty = node.y + 0.5;
    const dx = tx - v.x, dy = ty - v.y;
    const d = Math.hypot(dx, dy);
    const sp = (v.isChild ? 2.4 : 3.1) * dt;
    if (d <= sp) { v.x = tx; v.y = ty; v.pathIdx++; }
    else {
      v.x += dx / d * sp; v.y += dy / d * sp;
      if (dx !== 0) v.facing = dx > 0 ? 1 : -1;
    }
    v.animT += dt;
    return;
  }
  v.path = null;

  switch (v.state) {
    case 'goto_chop': {
      const o = v.targetObj;
      if (!o || o.regrow > 0) { v.state = 'idle'; v.decideT = 0.3; break; }
      v.state = 'chop'; v.workT = Math.max(2, (4.5 - v.skill.chop * 0.4) / (v.tool === 'axe' ? 1.6 : 1));
      break;
    }
    case 'chop': {
      v.workT -= dt;
      if (v.workT <= 0) {
        const o = v.targetObj;
        if (o && o.regrow === 0) {
          removeObject(o);
          addObject('stump', o.x, o.y);
          regrowQueue.push({ x: o.x, y: o.y, at: simTime + 2 * DAY_LEN / rainMult() });
          v.carry.wood += Math.ceil(3 * v.skill.chop);
          v.skill.chop = Math.min(3, v.skill.chop + 0.06);
          totalWood += 3;
          logEvent('🪓', `${v.name} срубил дерево (+3 🪵${v.tool === 'axe' ? ' топором' : ''})`);
          if (hasTrait(v, 'hardworking') && rng() < 0.4) think(v, 'Работать так работать! Ещё одно!');
        }
        v.targetObj = null; v.state = 'idle'; v.decideT = 0.4 + rng() * 1.2;
      }
      break;
    }
    case 'goto_forage': {
      const o = v.targetObj;
      if (!o || o.depleted) { v.state = 'idle'; v.decideT = 0.3; break; }
      v.state = 'forage'; v.workT = 3;
      break;
    }
    case 'forage': {
      v.workT -= dt;
      if (v.workT <= 0) {
        const o = v.targetObj;
        if (o && !o.depleted) {
          o.depleted = true;
          o.regrowAt = simTime + (90 + rng() * 60) / rainMult();
          v.carry.berries += 2;
          v.skill.forage = Math.min(3, v.skill.forage + 0.05);
          if (v.eatIntent) {
            v.eatIntent = false;
            v.carry.berries = Math.max(0, v.carry.berries - 1);
            v.needs.hunger = Math.min(100, v.needs.hunger + 45);
            think(v, pick(THOUGHTS.eat));
          }
          logEvent('🍓', `${v.name} собрал ягоды (+2 🫐)`);
        }
        v.targetObj = null; v.state = 'idle'; v.decideT = 0.4 + rng();
      }
      break;
    }
    case 'goto_harvest': {
      const o = v.targetObj;
      if (!o || o.stage < 3) { v.state = 'idle'; v.decideT = 0.3; break; }
      v.state = 'harvest'; v.workT = 2.5;
      break;
    }
    case 'harvest': {
      v.workT -= dt;
      if (v.workT <= 0) {
        const o = v.targetObj;
        if (o && o.stage >= 3) {
          o.stage = 1;
          o.growAt = simTime + 60 / rainMult();
          v.carry.berries += 4;
          v.skill.forage = Math.min(3, v.skill.forage + 0.08);
          SIM.harvests++;
          logEvent('🌾', `${v.name} собрал урожай пшеницы (+4 🫐)`);
        }
        v.targetObj = null; v.state = 'idle'; v.decideT = 0.4;
      }
      break;
    }
    case 'goto_craft': {
      v.state = 'craft'; v.workT = 2.5;
      break;
    }
    case 'craft': {
      v.workT -= dt;
      if (v.workT <= 0) {
        const kind = v.craftKind;
        if (stocks.wood >= 8) {
          stocks.wood -= 8;
          v.tool = kind === 'axe' ? 'axe' : 'spear';
          logEvent('🔨', `${v.name} смастерил ${kind === 'axe' ? 'топор 🪓' : 'копьё 🔱'} (−8 🪵)`);
        } else {
          think(v, 'Дров на инструмент не хватило…');
        }
        v.state = 'idle'; v.decideT = 0.5;
      }
      break;
    }
    case 'hunt': {
      const a = animals.find(x => x.id === v.huntId && x.hp > 0);
      if (!a) { v.state = 'idle'; v.decideT = 0.5; v.huntId = 0; break; }
      const d = dist(v.x, v.y, a.x, a.y);
      if (d > 0.9) {
        // прямая погоня
        v.repathT = (v.repathT || 0) - dt;
        if (v.repathT <= 0) {
          v.repathT = 0.4;
          v.path = astar(v.x, v.y, Math.floor(a.x), Math.floor(a.y));
          v.pathIdx = 0;
          if (!v.path) {
            // не дойти по сетке — идём напрямую
            steer(v, a.x, a.y, 3.0, dt);
          }
        } else if (!v.path) steer(v, a.x, a.y, 3.0, dt);
      } else {
        a.hp = 0;
        v.huntId = 0;
        v.carry.berries += 2;
        logEvent('🏹', `${v.name} поймал кролика (+2 🫐)`);
        if (v.eatIntent) {
          v.eatIntent = false;
          v.carry.berries = Math.max(0, v.carry.berries - 1);
          v.needs.hunger = Math.min(100, v.needs.hunger + 45);
          think(v, 'Свежатина! Ням.');
        }
        v.state = 'idle'; v.decideT = 1;
      }
      break;
    }
    case 'fight': {
      const m = monsters.find(mm => mm.id === v.fightId && mm.hp > 0);
      if (!m) { v.state = 'idle'; v.decideT = 0.5; break; }
      const d = dist(v.x, v.y, m.x, m.y);
      if (d > 1.1) {
        v.repathT -= dt;
        if (v.repathT <= 0) {
          v.repathT = 0.6;
          const t = approachTile(v, Math.floor(m.x), Math.floor(m.y));
          if (t) { v.path = astar(v.x, v.y, t.x, t.y); v.pathIdx = 0; }
          if (!v.path) steer(v, m.x, m.y, 2.6, dt);
        } else if (!v.path) steer(v, m.x, m.y, 2.6, dt);
      } else {
        v.atkT -= dt;
        if (v.atkT <= 0) {
          v.atkT = 0.8;
          const dmg = (v.tool === 'spear' ? 7 : 4) * (0.5 + v.skill.combat * 0.5) + (hasTrait(v, 'brave') ? 1 : 0);
          m.hp -= dmg;
          v.skill.combat = Math.min(3, v.skill.combat + 0.08);
          if (m.hp <= 0) {
            killMonster(m, `${v.name} одолел её`);
            think(v, 'Победа! Деревня в безопасности.');
            v.state = 'idle'; v.decideT = 1.2;
          }
        }
      }
      break;
    }
    case 'flee': {
      v.state = 'hide'; v.stateT = 8;
      break;
    }
    case 'hide': {
      v.hp = Math.min(20, v.hp + 0.9 * dt);
      v.stateT -= dt;
      if (v.stateT <= 0) { v.state = 'idle'; v.decideT = 0.4; }
      break;
    }
    case 'goto_deposit': {
      stocks.wood += v.carry.wood; stocks.berries += v.carry.berries;
      if (v.carry.wood > 0 || v.carry.berries > 0)
        logEvent('📦', `${v.name} сдал запасы: +${v.carry.wood} 🪵 +${v.carry.berries} 🫐`);
      v.carry = { wood: 0, berries: 0 };
      v.state = 'idle'; v.decideT = 0.5 + rng();
      break;
    }
    case 'goto_eat': {
      if (stocks.berries > 0) {
        stocks.berries--;
        v.needs.hunger = Math.min(100, v.needs.hunger + 55);
        v.state = 'eat'; v.workT = 2;
        think(v, pick(THOUGHTS.eat));
      } else { v.state = 'idle'; v.decideT = 0.3; }
      break;
    }
    case 'eat': {
      v.workT -= dt;
      if (v.workT <= 0) { v.state = 'idle'; v.decideT = 0.4; }
      break;
    }
    case 'goto_sleep': {
      v.state = 'sleep';
      think(v, pick(THOUGHTS.sleep));
      break;
    }
    case 'goto_social': {
      const other = villagers.find(o => o.id === (v.targetVil && v.targetVil.id));
      if (!other) { v.state = 'idle'; v.decideT = 0.5; break; }
      const d = dist(other.x, other.y, v.x, v.y);
      if (d > 1.6) {
        const p = astar(v.x, v.y, Math.floor(other.x), Math.floor(other.y));
        if (p && p.length > 0) { v.path = p.slice(0, Math.ceil(p.length / 2)); v.pathIdx = 0; }
        else { v.state = 'idle'; v.decideT = 1; }
        break;
      }
      v.state = 'social'; v.workT = 3; v.socialWith = other.id;
      if (other.state !== 'social' && other.state !== 'goto_social') {
        other.state = 'social'; other.workT = 3; other.socialWith = v.id; think(other, pick(THOUGHTS.social));
      }
      break;
    }
    case 'social': {
      v.workT -= dt;
      if (v.workT <= 0) {
        v.needs.social = 100;
        const other = villagers.find(o => o.id === v.socialWith);
        if (other && other.state === 'social') { other.needs.social = 100; other.state = 'idle'; other.decideT = 1; }
        if (rng() < 0.5) logEvent('💬', `${v.name} и ${other ? other.name : 'кто-то'} поболтали у костра`);
        v.state = 'idle'; v.decideT = 1;
      }
      break;
    }
    case 'goto_build': {
      if (!pendingBuild || pendingBuild.assigned !== v) { v.state = 'idle'; v.decideT = 0.5; break; }
      v.state = 'build'; v.workT = 6;
      break;
    }
    case 'build': {
      v.workT -= dt;
      if (v.workT <= 0) {
        if (pendingBuild && pendingBuild.assigned === v) {
          const { kind, x, y } = pendingBuild;
          if (kind === 'farm' && stocks.wood >= 15) {
            stocks.wood -= 15;
            if (addObject('farm', x, y)) {
              const f = farms[farms.length - 1];
              f.growAt = simTime + 60 / rainMult();
              logEvent('🌾', `${v.name} распахал поле. Будет хлеб!`);
            }
          } else if (stocks.wood >= 25) {
            stocks.wood -= 25;
            if (addHut(x, y)) logEvent('🏠', `${v.name} построил хижину! Деревня растёт.`);
          }
          pendingBuild = null;
        }
        v.state = 'idle'; v.decideT = 1;
      }
      break;
    }
    case 'goto_camp': {
      v.state = 'idle'; v.decideT = 0.5;
      think(v, 'Вот и деревня. Красиво тут!');
      break;
    }
    case 'wander': {
      v.state = 'idle'; v.decideT = 0.5 + rng() * 1.5;
      break;
    }
    case 'idle':
    default: {
      v.decideT -= dt;
      if (v.decideT <= 0) decide(v);
      break;
    }
  }
}

function processRegrow() {
  for (let i = regrowQueue.length - 1; i >= 0; i--) {
    const r = regrowQueue[i];
    if (simTime >= r.at) {
      const o = objAt.get(key(r.x, r.y));
      if (o && o.type === 'stump') {
        removeObject(o);
        addObject('tree', r.x, r.y);
      }
      regrowQueue.splice(i, 1);
    }
  }
}

// ── Хроника ───────────────────────────────────────────────────────
const chronicleEl = document.getElementById('chronicle');
function logEvent(icon, text) {
  const d = document.createElement('div');
  d.className = 'chron-item';
  const day = Math.floor(simTime / DAY_LEN) + 1;
  const p = phase();
  const hh = String(Math.floor(p * 24)).padStart(2, '0');
  const mm = String(Math.floor((p * 24 % 1) * 60)).padStart(2, '0');
  d.innerHTML = `<span class="chron-icon">${icon}</span><span class="chron-time">Д${day} ${hh}:${mm}</span> ${text}`;
  chronicleEl.prepend(d);
  while (chronicleEl.children.length > 60) chronicleEl.lastChild.remove();
}

// ── Отрисовка ─────────────────────────────────────────────────────
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let cw = 0, ch = 0;
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cw = window.innerWidth; ch = window.innerHeight;
  canvas.width = cw * dpr; canvas.height = ch * dpr;
  canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);

function draw() {
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#0b0d14';
  ctx.fillRect(0, 0, cw, ch);
  if (!mapCanvas) return;
  const z = zoom;
  ctx.save();
  ctx.translate(cw / 2, ch / 2);
  ctx.scale(z, z);
  ctx.translate(-camX, -camY);
  ctx.drawImage(mapCanvas, 0, 0);
  const drawList = [];
  for (const o of objects) drawList.push({ y: o.y, draw: () => drawObject(o) });
  for (const a of animals) if (a.hp > 0) drawList.push({ y: a.y, draw: () => drawAnimal(a) });
  for (const m of monsters) drawList.push({ y: m.y, draw: () => drawMonster(m) });
  for (const v of villagers) drawList.push({ y: v.y + 0.4, draw: () => drawVillager(v) });
  drawList.sort((a, b) => a.y - b.y);
  for (const d of drawList) d.draw();
  ctx.restore();
  // ночь
  const night = nightAmount();
  if (night > 0) {
    ctx.fillStyle = `rgba(16,20,52,${(night * 0.52).toFixed(3)})`;
    ctx.fillRect(0, 0, cw, ch);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const fx = (campfire.x * TILE + 4 - camX) * z + cw / 2;
    const fy = (campfire.y * TILE + 4 - camY) * z + ch / 2;
    const flick = 0.85 + Math.sin(performance.now() / 130) * 0.15;
    const rad = ctx.createRadialGradient(fx, fy, 0, fx, fy, 90 * z * flick);
    rad.addColorStop(0, `rgba(255,150,50,${0.30 * night})`);
    rad.addColorStop(1, 'rgba(255,150,50,0)');
    ctx.fillStyle = rad;
    ctx.fillRect(fx - 100 * z, fy - 100 * z, 200 * z, 200 * z);
    ctx.restore();
  }
  // дождь
  if (weather.rain) {
    ctx.fillStyle = 'rgba(40,60,110,0.18)';
    ctx.fillRect(0, 0, cw, ch);
    ctx.strokeStyle = 'rgba(180,200,255,0.45)';
    ctx.lineWidth = 1;
    const t = performance.now() / 1000;
    ctx.beginPath();
    for (let i = 0; i < 90; i++) {
      const rx = (i * 137 + (t * 260 + i * 31)) % cw;
      const ry = (i * 79 + t * 520) % ch;
      ctx.moveTo(rx, ry);
      ctx.lineTo(rx - 3, ry + 11);
    }
    ctx.stroke();
  }
  // молния
  if (weather.bolt > 0) {
    ctx.fillStyle = `rgba(255,255,255,${(weather.bolt * 0.5).toFixed(2)})`;
    ctx.fillRect(0, 0, cw, ch);
  }
  // пузыри мыслей
  for (const v of villagers) {
    if (v.thought && simTime < v.thoughtUntil) {
      const sx = (v.x * TILE - camX) * z + cw / 2;
      const sy = (v.y * TILE - 18 - camY) * z + ch / 2;
      drawBubble(sx, sy, v.thought, v === selected);
    }
  }
  // zZ над спящими
  if (night > 0.3) {
    for (const v of villagers) {
      if (v.state === 'sleep') {
        const sx = (v.x * TILE - camX) * z + cw / 2;
        const sy = (v.y * TILE - 14 - camY) * z + ch / 2;
        ctx.font = `${Math.round(10 * Math.min(z, 2))}px sans-serif`;
        ctx.fillStyle = 'rgba(200,210,255,0.9)';
        const t = (performance.now() / 500) % 2;
        ctx.fillText('z', sx + 4, sy - t * 4);
      }
    }
  }
}

function drawObject(o) {
  const x = o.x * TILE, y = o.y * TILE;
  switch (o.type) {
    case 'tree': ctx.drawImage(spr.tree[o.variant % 3], x - 1, y - 6); break;
    case 'pine': ctx.drawImage(spr.pine[o.variant % 3], x - 1, y - 6); break;
    case 'bush': ctx.drawImage(spr.bush[o.depleted ? 1 : 0], x - 1, y + 2); break;
    case 'stone': ctx.drawImage(spr.stone, x, y + 1); break;
    case 'flower': ctx.drawImage(spr.flower, x + 1, y + 1); break;
    case 'stump': ctx.drawImage(spr.stump, x + 1, y + 4); break;
    case 'grave': ctx.drawImage(spr.grave, x + 1, y + 2); break;
    case 'farm': ctx.drawImage(spr.farm[o.stage] || spr.farm[1], x - 4, y - 1); break;
    case 'hut': {
      ctx.drawImage(spr.hut, x - 4, y - 6);
      if (nightAmount() > 0.3) {
        ctx.fillStyle = 'rgba(255,220,120,0.9)';
        ctx.fillRect(x - 4 + spr.hutWindow.x, y - 6 + spr.hutWindow.y, spr.hutWindow.w, spr.hutWindow.h);
      }
      break;
    }
    case 'campfire': {
      ctx.drawImage(spr.campfire, x - 1, y - 1);
      const f = Math.sin(performance.now() / 90 + o.id);
      const h2 = 5 + f * 1.5;
      ctx.fillStyle = 'rgb(255,120,30)';
      ctx.fillRect(x + 2, y + 3 - h2, 4, h2);
      ctx.fillStyle = 'rgb(255,200,60)';
      ctx.fillRect(x + 3, y + 4 - h2 * 0.6, 2, h2 * 0.6);
      break;
    }
  }
}

function drawAnimal(a) {
  const x = a.x * TILE - 3, y = a.y * TILE - 3;
  const frame = Math.floor(a.animT * 6) % 2;
  if (a.kind === 'rabbit') {
    const set = a.facing >= 0 ? spr.rabbit : spr.rabbit;
    ctx.drawImage(set[frame], Math.round(x), Math.round(y));
  } else {
    const set = a.facing >= 0 ? spr.wolf : spr.wolf;
    ctx.drawImage(set[frame], Math.round(x), Math.round(y));
  }
}

function drawMonster(m) {
  const x = m.x * TILE - 4, y = m.y * TILE - 4;
  const frame = Math.floor(m.animT * 3) % 2;
  ctx.drawImage(spr.slime[frame], Math.round(x), Math.round(y));
  // полоска HP
  if (m.hp < m.maxHp) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x, y - 3, 8, 2);
    ctx.fillStyle = 'rgb(120,220,80)';
    ctx.fillRect(x, y - 3, 8 * Math.max(0, m.hp) / m.maxHp, 2);
  }
}

function drawVillager(v) {
  const scale = v.isChild ? 0.65 : 1;
  const x = v.x * TILE - 4, y = v.y * TILE - 6 + (v.isChild ? 4 : 0);
  if (v === selected) {
    ctx.strokeStyle = 'rgba(140,120,255,0.9)';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(x - 1.5, y - 1.5, 11, 16.5);
  }
  const moving = v.path && v.pathIdx < v.path.length;
  const frame = moving && Math.floor((v.animT || 0) * 6) % 2 ? 1 : 0;
  const set = v.facing >= 0 ? spr.villagerFrames[v.bodyIdx] : spr.villagerFlip[v.bodyIdx];
  if (v.isChild) ctx.drawImage(set[frame], Math.round(x), Math.round(y), 8 * scale, 14 * scale);
  else ctx.drawImage(set[frame], Math.round(x), Math.round(y));
  // имя при зуме
  if (zoom >= 2) {
    ctx.font = '4px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textAlign = 'center';
    ctx.fillText(v.name, x + 4, y - 1);
    ctx.textAlign = 'left';
  }
  // сердечки HP (если ранен)
  if (v.hp < 20) {
    const hearts = Math.ceil(v.hp / 4);
    for (let i = 0; i < hearts; i++) {
      ctx.fillStyle = 'rgb(220,60,80)';
      ctx.fillRect(x + i * 2, y - 4, 1.5, 1.5);
    }
  }
  // иконки занятия
  if (v.state === 'chop') { ctx.font = '5px sans-serif'; ctx.fillText(v.tool === 'axe' ? '🪓' : '✊', x + 8, y + 4); }
  if (v.state === 'fight') { ctx.font = '5px sans-serif'; ctx.fillText(v.tool === 'spear' ? '🔱' : '👊', x + 8, y + 4); }
  if (v.state === 'craft') { ctx.font = '5px sans-serif'; ctx.fillText('🔨', x + 8, y + 4); }
  if (v.state === 'hunt') { ctx.font = '5px sans-serif'; ctx.fillText('🏹', x + 8, y + 4); }
}

function drawBubble(sx, sy, text, isSel) {
  ctx.font = '12px sans-serif';
  const pad = 7;
  const wTxt = ctx.measureText(text).width;
  const bw = wTxt + pad * 2, bh = 22;
  let x = sx - bw / 2, yy = sy - bh - 6;
  x = Math.max(4, Math.min(cw - bw - 4, x));
  yy = Math.max(4, yy);
  ctx.fillStyle = isSel ? 'rgba(60,50,110,0.95)' : 'rgba(24,28,44,0.92)';
  ctx.strokeStyle = isSel ? 'rgba(150,130,255,0.8)' : 'rgba(90,100,130,0.5)';
  roundRect(x, yy, bw, bh, 6);
  ctx.fill(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx - 3, yy + bh); ctx.lineTo(sx + 3, yy + bh); ctx.lineTo(sx, yy + bh + 5);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#e8eaf2';
  ctx.fillText(text, x + pad, yy + 15);
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ── Панель жителя ────────────────────────────────────────────────
const panelEl = document.getElementById('villagerPanel');
function updatePanel() {
  if (!selected) { panelEl.style.display = 'none'; return; }
  const v = selected;
  panelEl.style.display = 'block';
  const n = v.needs;
  const stateLabels = {
    idle: 'думает', wander: 'гуляет', chop: 'рубит дерево', forage: 'собирает ягоды',
    eat: 'ест', sleep: 'спит 😴', social: 'болтает', build: 'строит', craft: 'мастерит',
    hunt: 'охотится 🏹', fight: 'сражается ⚔️', flee: 'убегает!', hide: 'прячется в доме',
    harvest: 'собирает урожай',
    goto_chop: 'идёт к дереву', goto_forage: 'идёт к кустам', goto_deposit: 'несёт запасы',
    goto_eat: 'идёт поесть', goto_sleep: 'идёт спать', goto_social: 'идёт болтать',
    goto_build: 'идёт на стройку', goto_craft: 'идёт к наковальне', goto_harvest: 'идёт на поле',
    goto_camp: 'приходит в деревню'
  };
  const act = stateLabels[v.state] || v.state;
  const carry = [];
  if (v.carry.wood) carry.push(`🪵 ${v.carry.wood}`);
  if (v.carry.berries) carry.push(`🫐 ${v.carry.berries}`);
  const toolLabel = v.tool === 'axe' ? '🪓 топор' : v.tool === 'spear' ? '🔱 копьё' : '—';
  const skills = `🪓${v.skill.chop.toFixed(1)} 🏹${v.skill.forage.toFixed(1)} ⚔️${v.skill.combat.toFixed(1)}`;
  const thoughtsHtml = v.thoughts.slice(0, 6).map(t => {
    const day = Math.floor(t.t / DAY_LEN) + 1;
    const hh = String(Math.floor(phase2(t.t) * 24)).padStart(2, '0');
    return `<div class="thought">«${t.text}» <span class="thought-time">Д${day} ${hh}:00</span></div>`;
  }).join('');
  panelEl.innerHTML = `
    <div class="vp-head">
      <canvas class="vp-portrait" id="vpPortrait" width="48" height="48"></canvas>
      <div>
        <div class="vp-name">${v.name}${v.isChild ? ' 🧒' : ''}</div>
        <div class="vp-traits">${v.traits.map(t => t.label).join(' · ')}</div>
      </div>
      <button class="vp-close" id="vpClose">✕</button>
    </div>
    <div class="vp-action">Сейчас: <b>${act}</b></div>
    <div class="vp-bars">
      ${bar('Здоровье', v.hp * 5, '#e05c6c')}
      ${bar('Сытость', n.hunger, '#e0a44c')}
      ${bar('Энергия', n.energy, '#5cb85c')}
      ${bar('Общение', n.social, '#7c8cff')}
    </div>
    <div class="vp-carry">Инструмент: ${toolLabel} · Навыки: ${skills}</div>
    <div class="vp-carry">${carry.length ? 'Несёт: ' + carry.join(', ') : 'Руки свободны'}</div>
    <div class="vp-thoughts">${thoughtsHtml || '<span style="opacity:.5">Пока думает о чём-то своём…</span>'}</div>
  `;
  const portrait = document.getElementById('vpPortrait');
  const g = portrait.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#171b28';
  g.fillRect(0, 0, 48, 48);
  const set = spr.villagerFrames[v.bodyIdx];
  g.save();
  g.scale(6, 6);
  g.drawImage(set[0], 0, 0, 8, 7, 0, 0, 8, 7);
  g.restore();
  document.getElementById('vpClose').onclick = () => { selected = null; };
}
function phase2(t) { return (t % DAY_LEN) / DAY_LEN; }
function bar(label, val, color) {
  return `<div class="bar-row"><span class="bar-label">${label}</span>
    <div class="bar"><div class="bar-fill" style="width:${Math.max(0, Math.min(100, val)).toFixed(0)}%;background:${color}"></div></div></div>`;
}

// ── Верхняя панель ────────────────────────────────────────────────
const statsEl = document.getElementById('stats');
function updateStats() {
  const day = Math.floor(simTime / DAY_LEN) + 1;
  const p = phase();
  const hh = String(Math.floor(p * 24)).padStart(2, '0');
  const mm = String(Math.floor((p * 24 % 1) * 60)).padStart(2, '0');
  const phaseName = p < 0.1 ? '🌅 рассвет' : p < 0.3 ? '☀️ утро' : p < 0.55 ? '🌤 день' : p < 0.65 ? '🌇 вечер' : '🌙 ночь';
  const weatherIcon = weather.rain ? '🌧' : '';
  const danger = monsters.length ? ` <span class="danger">👾 ${monsters.length}!</span>` : '';
  statsEl.innerHTML = `День <b>${day}</b> <span class="dim">${hh}:${mm} ${phaseName}${weatherIcon}</span>${danger}
    &nbsp;·&nbsp; 👥 <b>${villagers.length}</b>
    &nbsp;·&nbsp; 🪵 <b>${stocks.wood}</b>
    &nbsp;·&nbsp; 🫐 <b>${stocks.berries}</b>
    &nbsp;·&nbsp; 🏠 <b>${huts.length}</b>
    &nbsp;·&nbsp; 🐺 <b>${animals.filter(a => a.kind === 'wolf' && a.hp > 0).length}</b>
    &nbsp;·&nbsp; <span class="dim">сид ${seed}</span>`;
}

// ── Ввод ─────────────────────────────────────────────────────────
let pointers = new Map();
let dragMoved = 0;
canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  dragMoved = 0;
});
canvas.addEventListener('pointermove', e => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (pointers.size === 1) {
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    dragMoved += Math.abs(dx) + Math.abs(dy);
    camX -= dx / zoom; camY -= dy / zoom;
    clampCam();
  } else if (pointers.size === 2) {
    const arr = [...pointers.values()];
    const p2 = { x: e.clientX, y: e.clientY };
    const first = arr[0] === p ? p2 : arr[0];
    const second = arr[0] === p ? arr[1] : p;
    const oldD = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
    const newD = Math.hypot(first.x - second.x, first.y - second.y);
    if (oldD > 0 && newD > 0) { zoom = Math.max(0.8, Math.min(5, zoom * newD / oldD)); clampCam(); }
  }
  p.x = e.clientX; p.y = e.clientY;
});
function endPointer(e) {
  if (pointers.has(e.pointerId) && pointers.size === 1 && dragMoved < 8) {
    const wx = (e.clientX - cw / 2) / zoom + camX;
    const wy = (e.clientY - ch / 2) / zoom + camY;
    let best = null, bd = 14;
    for (const v of villagers) {
      const d = Math.hypot(v.x * TILE - wx, v.y * TILE - wy);
      if (d < bd) { bd = d; best = v; }
    }
    selected = best;
    updatePanel();
  }
  pointers.delete(e.pointerId);
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  zoom = Math.max(0.8, Math.min(5, zoom * (e.deltaY < 0 ? 1.15 : 0.87)));
  clampCam();
}, { passive: false });
function clampCam() {
  const halfW = cw / 2 / zoom, halfH = ch / 2 / zoom;
  camX = Math.max(Math.min(camX, MAP_W - halfW + 40), halfW - 40);
  camY = Math.max(Math.min(camY, MAP_H - halfH + 40), halfH - 40);
}

// ── Кнопки ────────────────────────────────────────────────────────
document.getElementById('btnPause').onclick = () => {
  paused = !paused;
  document.getElementById('btnPause').textContent = paused ? '▶' : '⏸';
};
document.getElementById('btnSpeed').onclick = () => {
  simSpeed = simSpeed === 1 ? 2 : simSpeed === 2 ? 4 : 1;
  document.getElementById('btnSpeed').textContent = simSpeed + '×';
};
document.getElementById('btnWorld').onclick = () => {
  seed = (seed * 16807 + 11) % 2147483647;
  genWorld(seed);
  chronicleEl.innerHTML = '';
  logEvent('🎲', 'Новый мир создан! Сид: ' + seed);
  focusVillage();
};
document.getElementById('btnZoomIn').onclick = () => { zoom = Math.min(5, zoom * 1.25); clampCam(); };
document.getElementById('btnZoomOut').onclick = () => { zoom = Math.max(0.8, zoom / 1.25); clampCam(); };
document.getElementById('btnFollow').onclick = () => {
  if (selected) { camX = selected.x * TILE; camY = selected.y * TILE; }
};
function focusVillage() {
  camX = campfire.x * TILE + 4;
  camY = campfire.y * TILE + 4;
  zoom = Math.max(1.2, Math.min(2.5, ch / MAP_H * 1.4));
  clampCam();
}
document.getElementById('btnIntro').onclick = () => {
  document.getElementById('intro').style.display = 'none';
};

// ── Главный цикл ───────────────────────────────────────────────────
let lastT = performance.now();
let statT = 0, panelT = 0;
function loop(now) {
  let dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (!paused && world) {
    const sdt = Math.min(0.25, dt * simSpeed);
    updateSim(sdt);
  }
  draw();
  statT += dt;
  if (statT > 0.5) { statT = 0; updateStats(); }
  panelT += dt;
  if (selected && panelT > 0.7) { panelT = 0; updatePanel(); }
  requestAnimationFrame(loop);
}

// ── Старт ─────────────────────────────────────────────────────────
resize();
makeTextures();
genWorld(seed);
focusVillage();
logEvent('🌱', `Мир сгенерирован из сида ${seed}. Каждый мир уникален.`);
logEvent('🐺', 'В лесу живут волки и кролики. Ночью берегись слайм!');
requestAnimationFrame(loop);
