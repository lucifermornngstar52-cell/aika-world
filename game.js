'use strict';
/* ═══════════════════════════════════════════════════════════════════
   АЙКА МИР — прототип живой пиксельной деревни.
   Мир генерируется случайно, жители думают и развивают деревню сами.
   ═══════════════════════════════════════════════════════════════════ */

// ── Константы мира ────────────────────────────────────────────────
const W = 120, H = 76, TILE = 8;
const MAP_W = W * TILE, MAP_H = H * TILE;
const DAY_LEN = 240; // сим-секунд на сутки

// ── Глобальное состояние ──────────────────────────────────────────
let world = null;          // {tile:Uint8Array}
let objects = [];          // все объекты карты
let objAt = new Map();     // key -> объект
let villagers = [];
let campfire = { x: 0, y: 0 };
let huts = [];
let stocks = { wood: 0, berries: 6 };
let totalWood = 0;
let pendingBuild = null;
let settlersThresholds = [45, 110, 200, 320, 470];
let settlersSpawned = 0;
let simTime = 0;
let simSpeed = 1, paused = false;
let seed = (Date.now() % 2147483647) | 0;
let rng = null;
let camX = 0, camY = 0, zoom = 1.6;
let selected = null;
let nextId = 1;

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
// 0 deep, 1 water, 2 sand, 3 grass, 4 meadow, 5 rock, 6 snow
const TILE_COLORS = {
  0: [27, 54, 93], 1: [52, 110, 166], 2: [216, 196, 122],
  3: [94, 140, 66], 4: [110, 156, 74], 5: [120, 120, 128], 6: [225, 228, 235]
};
const isWalkTile = t => t >= 2 && t <= 4;
const BLOCKING = new Set(['tree', 'pine', 'bush', 'stone', 'hut', 'campfire']);

function blockingAt(x, y) {
  const o = objAt.get(key(x, y));
  return o && BLOCKING.has(o.type);
}
const walkable = (x, y) => inb(x, y) && isWalkTile(world[key(x, y)]) && !blockingAt(x, y);

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
  // объекты
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
  // очистить место для деревни: ищем большую поляну у центра
  let best = null, bestScore = -1;
  for (let ty = 12; ty < H - 12; ty += 2) {
    for (let tx = 12; tx < W - 12; tx += 2) {
      if (!walkable(tx, ty)) continue;
      let score = 0;
      for (let k = 0; k < 40; k++) {
        const ox = tx + Math.floor(rng() * 13) - 6, oy = ty + Math.floor(rng() * 13) - 6;
        if (walkable(ox, oy)) score++;
      }
      const toCenter = 400 - dist2(tx, ty, W / 2, H / 2) * 0.5;
      score += toCenter * 0.02;
      if (score > bestScore) { bestScore = score; best = { x: tx, y: ty }; }
    }
  }
  if (!best) best = { x: W >> 1, y: H >> 1 };
  campfire.x = best.x; campfire.y = best.y;
  // очистить радиус 3 от деревьев
  for (let y = best.y - 3; y <= best.y + 3; y++)
    for (let x = best.x - 3; x <= best.x + 3; x++) {
      const o = objAt.get(key(x, y));
      if (o && (o.type === 'tree' || o.type === 'bush' || o.type === 'stone' || o.type === 'pine')) removeObject(o);
    }
  addObject('campfire', campfire.x, campfire.y);
  huts = [];
  addHut(best.x - 3, best.y - 1);
  addHut(best.x + 3, best.y + 1);

  // жители
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
  stocks = { wood: 0, berries: 6 };
  totalWood = 0; pendingBuild = null; settlersSpawned = 0;
  simTime = 0; selected = null;
  renderMapCanvas();
  logEvent('🔥', 'Деревня основана! Костёр горит, жители готовы к труду.');
}

function addObject(type, x, y) {
  const o = { id: nextId++, type, x, y };
  if (type === 'tree') { o.variant = Math.floor(rng() * 3); o.regrow = 0; }
  if (type === 'pine') o.variant = Math.floor(rng() * 3);
  if (type === 'bush') o.depleted = false;
  objects.push(o); objAt.set(key(x, y), o);
  return o;
}
function removeObject(o) {
  const i = objects.indexOf(o);
  if (i >= 0) objects.splice(i, 1);
  objAt.delete(key(o.x, o.y));
}
function addHut(x, y) {
  if (!walkable(x, y)) return false;
  addObject('hut', x, y);
  huts.push({ x, y });
  return true;
}

// ── Текстуры (пиксель-арт генерируется кодом) ─────────────────────
const tileTex = {};   // type -> [canvas×4]
const spr = {};       // спрайты объектов и персонажей

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
      // детали
      if (+t === 3 || +t === 4) { // травинки
        for (let k = 0; k < 3; k++) {
          const x = Math.floor(r() * 8), y = Math.floor(r() * 8);
          const d = r() < 0.5 ? [62, 104, 44] : [128, 172, 88];
          px(g, x, y, d[0], d[1], d[2]);
        }
      }
      if (+t === 2) { // песчаные крапинки
        for (let k = 0; k < 2; k++)
          px(g, Math.floor(r() * 8), Math.floor(r() * 8), 190, 170, 100);
      }
      if (+t === 5) { // трещины
        const x0 = Math.floor(r() * 6), y0 = Math.floor(r() * 8);
        px(g, x0, y0, 90, 90, 98); px(g, x0 + 1, y0, 90, 90, 98);
      }
      if (+t === 4 && r() < 0.5) { // цветочки на лугу
        const fx2 = Math.floor(r() * 7), fy = Math.floor(r() * 7);
        const col = r() < 0.5 ? [235, 220, 120] : [220, 130, 150];
        px(g, fx2, fy, col[0], col[1], col[2]);
      }
      tileTex[t].push(c);
    }
  }
  // ── деревья (3 варианта) ──
  spr.tree = [];
  for (let v = 0; v < 3; v++) {
    const c = document.createElement('canvas'); c.width = 10; c.height = 14;
    const g = c.getContext('2d');
    g.fillStyle = 'rgb(92,64,38)'; g.fillRect(4, 9, 2, 5);           // ствол
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
  // ── сосна ──
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
  // ── куст ягодный ──
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
  // ── камень ──
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
  // ── цветок ──
  spr.flower = (() => {
    const c = document.createElement('canvas'); c.width = 6; c.height = 6;
    const g = c.getContext('2d');
    px(g, 2, 5, 70, 120, 50);
    px(g, 2, 4, 70, 120, 50);
    const cols = [[240, 210, 90], [235, 130, 140], [140, 160, 240]];
    const col = cols[Math.floor(r() * 3)];
    px(g, 2, 3, col[0], col[1], col[2]); px(g, 1, 3, col[0], col[1], col[2]);
    px(g, 3, 3, col[0], col[1], col[2]); px(g, 2, 2, col[0], col[1], col[2]);
    return c;
  })();
  // ── пень ──
  spr.stump = (() => {
    const c = document.createElement('canvas'); c.width = 6; c.height = 4;
    const g = c.getContext('2d');
    for (let y = 1; y < 4; y++) for (let x = 0; x < 6; x++)
      if (y < 2 || (x > 0 && x < 5)) px(g, x, y, 110, 80, 50);
    px(g, 1, 0, 150, 116, 76); px(g, 2, 0, 150, 116, 76); px(g, 3, 0, 150, 116, 76);
    px(g, 2, 1, 120, 90, 58);
    return c;
  })();
  // ── хижина ──
  spr.hut = (() => {
    const c = document.createElement('canvas'); c.width = 16; c.height = 14;
    const g = c.getContext('2d');
    // стены
    for (let y = 7; y < 13; y++) for (let x = 2; x < 14; x++) {
      const col = (x + y) % 2 ? [150, 110, 70] : [135, 98, 62];
      px(g, x, y, col[0], col[1], col[2]);
    }
    // крыша
    for (let row = 0; row < 7; row++) {
      for (let x = 1 + row; x < 15 - row; x++) {
        const col = row % 2 ? [96, 62, 44] : [118, 78, 52];
        px(g, x, row, col[0], col[1], col[2]);
      }
    }
    // окно и дверь
    px(g, 4, 9, 40, 30, 24); px(g, 5, 9, 40, 30, 24);
    px(g, 4, 10, 40, 30, 24); px(g, 5, 10, 40, 30, 24);
    for (let y = 9; y < 13; y++) px(g, 11, y, 62, 44, 30);
    // окно (свет)
    spr.hutWindow = { x: 4, y: 9, w: 2, h: 2 };
    return c;
  })();
  // ── костёр ──
  spr.campfire = (() => {
    const c = document.createElement('canvas'); c.width = 10; c.height = 10;
    const g = c.getContext('2d');
    // брёвна
    g.fillStyle = 'rgb(96,68,40)'; g.fillRect(1, 7, 8, 2);
    g.fillStyle = 'rgb(120,86,50)'; g.fillRect(2, 6, 6, 1);
    // камни вокруг
    px(g, 0, 8, 110, 110, 118); px(g, 9, 8, 110, 110, 118);
    return c;
  })();
  // ── персонажи ──
  const HAIRS = [[62, 38, 24], [30, 24, 20], [150, 100, 50], [90, 60, 30], [40, 44, 90], [110, 40, 44]];
  const SHIRTS = [[170, 60, 60], [60, 90, 170], [80, 140, 80], [170, 140, 60], [140, 80, 150], [90, 90, 100]];
  const PANTS = [[50, 52, 70], [70, 50, 40], [40, 60, 50]];
  const SKINS = [[238, 190, 150], [220, 170, 130], [196, 148, 108]];
  spr.bodies = [];
  for (const hair of HAIRS) for (const shirt of SHIRTS) {
    spr.bodies.push({ hair, shirt, pants: PANTS[Math.floor(r() * 3)], skin: SKINS[Math.floor(r() * 3)] });
  }
  makeVillagerSprites();
}

function makeVillagerSpriteSet(body) {
  // 2 кадра × 2 направления, 8×14
  const frames = [];
  for (let f = 0; f < 2; f++) {
    const c = document.createElement('canvas'); c.width = 8; c.height = 14;
    const g = c.getContext('2d');
    const { hair, shirt, pants, skin } = body;
    // волосы
    g.fillStyle = `rgb(${hair[0]},${hair[1]},${hair[2]})`;
    g.fillRect(1, 0, 6, 2); g.fillRect(0, 1, 8, 2);
    // лицо
    g.fillStyle = `rgb(${skin[0]},${skin[1]},${skin[2]})`;
    g.fillRect(1, 3, 6, 3);
    px(g, 2, 4, 30, 24, 22); px(g, 5, 4, 30, 24, 22); // глаза
    // рубаха
    g.fillStyle = `rgb(${shirt[0]},${shirt[1]},${shirt[2]})`;
    g.fillRect(1, 6, 6, 4);
    px(g, 0, 6, shirt[0], shirt[1], shirt[2]); px(g, 7, 6, shirt[0], shirt[1], shirt[2]); // руки
    px(g, 0, 7, skin[0], skin[1], skin[2]); px(g, 7, 7, skin[0], skin[1], skin[2]); // ладони
    // штаны
    g.fillStyle = `rgb(${pants[0]},${pants[1]},${pants[2]})`;
    g.fillRect(2, 10, 4, 2);
    // ноги (анимация)
    g.fillStyle = `rgb(${pants[0]},${pants[1]},${pants[2]})`;
    if (f === 0) { g.fillRect(2, 12, 2, 2); g.fillRect(5, 12, 1, 2); }
    else { g.fillRect(3, 12, 1, 2); g.fillRect(4, 12, 2, 2); }
    frames.push(c);
  }
  return frames;
}
function makeVillagerSprites() {
  spr.villagerFrames = spr.bodies.map(b => makeVillagerSpriteSet(b));
  spr.villagerFlip = spr.villagerFrames.map(f => {
    return f.map(c => {
      const c2 = document.createElement('canvas'); c2.width = 8; c2.height = 14;
      const g = c2.getContext('2d');
      g.translate(8, 0); g.scale(-1, 1); g.drawImage(c, 0, 0);
      return c2;
    });
  });
}

// ── Канвас карты (статичный слой) ─────────────────────────────────
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
      // берег: светлый кант у воды
      if (t >= 2 && t <= 4) {
        if (inb(x, y - 1) && world[key(x, y - 1)] <= 1) {
          g.fillStyle = 'rgba(220,220,180,0.25)'; g.fillRect(x * TILE, y * TILE, TILE, 1);
        }
      }
    }
}

// ── Персонажи ─────────────────────────────────────────────────────
const NAMES = ['Аскар', 'Дана', 'Марат', 'Айгерим', 'Тимур', 'Мадина', 'Арман', 'Камила', 'Ерлан', 'Сабина', 'Нурлан', 'Алия', 'Данияр', 'Жанна'];
const TRAITS = [
  { k: 'hardworking', label: 'трудолюбивый' },
  { k: 'sociable', label: 'общительный' },
  { k: 'curious', label: 'любопытный' },
  { k: 'dreamer', label: 'мечтательный' },
  { k: 'kind', label: 'добрый' },
  { k: 'stubborn', label: 'упрямый' }
];
const THOUGHTS = {
  chop: ['Дерево само себя не срубит.', 'Тук-тук-тук… делу время.', 'Настрою дров на всю деревню!', 'Хорошая древесина, крепкая.'],
  forage: ['Ягодки, сладкие как мёд!', 'Вот и кустик со спелыми ягодами.', 'Соберу-ка ягод на всех.', 'Мм, пахнет вкусно.'],
  eat: ['Ням… вот теперь можно и поработать.', 'Какая вкуснотища!', 'Сытый житель — счастливый житель.'],
  sleep: ['Какая звёздная ночь…', 'Спать-спать-спать…', 'Завтра будет новый день.', 'Дым костра убаюкивает…'],
  social: ['Сто лет не виделись!', 'Слышал, скоро новый дом строим?', 'Болтать у костра — лучшее время.', 'Расскажу-ка я историю…'],
  deposit: ['Вклад в общее дело!', 'Дрова в общую кучу — так честно.', 'Ещё немного и построим новый дом.'],
  wander: ['Пойду посмотрю, что там.', 'Интересно, что за холмом?', 'Прогулка ещё никому не мешала.', 'Мир большой, надо всё обойти.'],
  idle: ['Сегодня хороший день.', 'Чем бы заняться?', 'Птички поют… красота.', 'Дышится легко.'],
  greet: ['Новый человек! Надо познакомиться.', 'О, к нам пополнение!'],
  nightDream: ['Что там, за туманом?..', 'Звёзды… интересно, из чего они?']
};

function makeVillager(x, y, nameFree) {
  const bodyIdx = Math.floor(rng() * spr.bodies.length);
  const usedNames = villagers.map(v => v.name);
  const freeNames = NAMES.filter(n => !usedNames.includes(n));
  const name = freeNames.length ? freeNames[Math.floor(rng() * freeNames.length)] : 'Житель ' + nextId;
  const traits = [];
  const pool = [...TRAITS];
  for (let i = 0; i < 2 && pool.length; i++)
    traits.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return {
    id: nextId++, name, bodyIdx, traits,
    x, y, path: null, pathIdx: 0, facing: 1,
    state: 'idle', stateT: 0, workT: 0, targetObj: null, targetVil: null,
    carry: { wood: 0, berries: 0 },
    needs: { hunger: 70 + rng() * 30, energy: 70 + rng() * 30, social: 50 + rng() * 40 },
    skill: { chop: 1, forage: 1 },
    thought: '', thoughtUntil: 0, thoughts: [],
    home: null, decideT: rng() * 2
  };
}

function hasTrait(v, k) { return v.traits.some(t => t.k === k); }
function think(v, text) {
  v.thought = text;
  v.thoughtUntil = simTime + 5;
  v.thoughts.unshift({ t: simTime, text });
  if (v.thoughts.length > 8) v.thoughts.pop();
}

// ── Поиск пути (A*) ───────────────────────────────────────────────
class Heap {
  constructor() { this.a = []; }
  push(n, f) { this.a.push({ n, f }); let i = this.a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (this.a[p].f <= this.a[i].f) break; [this.a[p], this.a[i]] = [this.a[i], this.a[p]]; i = p; } }
  pop() { const top = this.a[0]; const last = this.a.pop(); if (this.a.length) { this.a[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < this.a.length && this.a[l].f < this.a[m].f) m = l; if (r < this.a.length && this.a[r].f < this.a[m].f) m = r; if (m === i) break; [this.a[m], this.a[i]] = [this.a[i], this.a[m]]; i = m; } } return top ? top.n : null; }
  get size() { return this.a.length; }
}
function astar(sx, sy, tx, ty) {
  if (!inb(tx, ty) || !walkable(tx, ty)) return null;
  sx = Math.floor(sx); sy = Math.floor(sy);
  if (!walkable(sx, sy)) { // стоим на непроходимом (могли занять объект) — разрешаем старт
  }
  if (sx === tx && sy === ty) return [];
  const open = new Heap();
  const g = new Map(), came = new Map();
  const startK = key(sx, sy);
  g.set(startK, 0);
  open.push({ x: sx, y: sy, k: startK }, 0);
  const F = (k, f) => f;
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
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cur.x + dx, ny = cur.y + dy;
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

// подойти к объекту: на соседнюю проходимую клетку (или на саму, если можно)
function approachTile(v, ox, oy) {
  if (walkable(ox, oy)) return { x: ox, y: oy };
  let best = null, bd = Infinity;
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const x = ox + dx, y = oy + dy;
    if (!walkable(x, y)) continue;
    const d = dist2(v.x, v.y, x, y);
    if (d < bd) { bd = d; best = { x, y }; }
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
function findNearestObj(v, types, filter) {
  let best = null, bd = Infinity;
  for (const o of objects) {
    if (!types.includes(o.type)) continue;
    if (o.regrow > simTime) continue;
    if (o.type === 'bush' && o.depleted) continue;
    if (filter && !filter(o)) continue;
    const d = dist2(v.x, v.y, o.x, o.y);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

// ── Время суток ───────────────────────────────────────────────────
function phase() { return (simTime % DAY_LEN) / DAY_LEN; }
function isNight() { const p = phase(); return p > 0.65 || p < 0.1; }
function nightAmount() {
  const p = phase();
  let n = 0;
  if (p > 0.58) n = Math.min(1, (p - 0.58) / 0.14);
  if (p < 0.2) n = Math.max(n, 1 - p / 0.2);
  return n;
}

// ── Принятие решений (примитивный utility-AI) ─────────────────────
function decide(v) {
  const night = isNight();
  const n = v.needs;
  if (pendingBuild && !pendingBuild.assigned && !night) { startBuild(v); return; }
  if (n.hunger < 32) { startEat(v); return; }
  if (n.energy < 22 || (night && n.energy < 70)) { startSleep(v); return; }
  if (v.carry.wood + v.carry.berries >= 6) { startDeposit(v); return; }
  if (n.social < 30 && !night) {
    const partner = villagers.find(o => o !== v && !['sleep', 'social'].includes(o.state) && o.needs.social < 60);
    if (partner) { startSocial(v, partner); return; }
  }
  // работа: ягоды для еды, дрова для строительства
  if (stocks.berries < 8 && !night) {
    const b = findNearestObj(v, ['bush']);
    if (b) { startForage(v, b); return; }
  }
  const t = findNearestObj(v, ['tree', 'pine']);
  if (t && !night) { startChop(v, t); return; }
  if (night && hasTrait(v, 'dreamer') && rng() < 0.5) { think(v, pick(THOUGHTS.nightDream)); startWander(v); return; }
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
    else { v.state = 'idle'; v.stateT = 3; think(v, 'В деревне пусто… надо искать еду.'); }
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
  partner.socialRequest = v.id;
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
  v.state = 'idle'; v.stateT = 1 + rng() * 2;
  if (rng() < 0.4) think(v, pick(THOUGHTS.idle));
}
function startBuild(v) {
  pendingBuild.assigned = v;
  v.path = astar(v.x, v.y, pendingBuild.x, pendingBuild.y); v.pathIdx = 0;
  v.state = 'goto_build';
  think(v, 'Строим новый дом! За работу.');
}

// ── Обновление симуляции ──────────────────────────────────────────
function updateSim(dt) {
  simTime += dt;
  const p = phase();
  // появление новых жителей
  if (settlersSpawned < settlersThresholds.length &&
      totalWood >= settlersThresholds[settlersSpawned] && !isNight()) {
    // найти свободный край карты
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
  // план постройки
  if (!pendingBuild && stocks.wood >= 25 && huts.length < 9 && !isNight()) {
    outer:
    for (let r = 2; r <= 7; r++) {
      for (let a = 0; a < 24; a++) {
        const ang = a / 24 * Math.PI * 2;
        const x = Math.round(campfire.x + Math.cos(ang) * r);
        const y = Math.round(campfire.y + Math.sin(ang) * r);
        if (walkable(x, y) && walkable(x, y + 1)) {
          // не рядом с костром вплотную
          if (dist2(x, y, campfire.x, campfire.y) >= 4) { pendingBuild = { x, y, assigned: null }; break outer; }
        }
      }
    }
  }
  // обновление жителей
  for (const v of villagers) {
    updateVillager(v, dt);
  }
  // респавн деревьев/кустов
  for (const o of objects) {
    if (o.type === 'tree' && o.regrow > 0 && simTime >= o.regrow) {
      o.regrow = 0;
    }
  }
}

function updateVillager(v, dt) {
  const n = v.needs;
  // потребности
  const working = ['chop', 'forage', 'goto_chop', 'goto_forage', 'goto_build', 'build'].includes(v.state);
  n.hunger = Math.max(0, n.hunger - dt * 0.09);
  n.energy = Math.max(0, n.energy - dt * (working ? 0.055 : v.state === 'sleep' ? -0.14 : 0.03));
  n.social = Math.max(0, n.social - dt * (v.state === 'social' ? -0.2 : 0.035));
  if (n.hunger < 12) n.energy = Math.max(0, n.energy - dt * 0.05); // голод изнуряет
  v.decideT -= dt;
  if (v.state === 'sleep') {
    if (phase() < 0.15 || phase() > 0.9 || n.hunger < 15) {
      v.state = 'idle'; v.decideT = 0.5;
      think(v, 'Доброе утро!');
    }
    return;
  }
  if (n.hunger < 18 && !['goto_eat', 'eat', 'goto_forage', 'forage'].includes(v.state) && v.decideT <= 0) {
    v.decideT = 1; decide(v); return;
  }
  // движение по пути
  if (v.path && v.pathIdx < v.path.length) {
    const node = v.path[v.pathIdx];
    const tx = node.x + 0.5, ty = node.y + 0.5;
    const dx = tx - v.x, dy = ty - v.y;
    const d = Math.hypot(dx, dy);
    const sp = 3.1 * dt;
    if (d <= sp) { v.x = tx; v.y = ty; v.pathIdx++; }
    else {
      v.x += dx / d * sp; v.y += dy / d * sp;
      if (dx !== 0) v.facing = dx > 0 ? 1 : -1;
    }
    v.animT = (v.animT || 0) + dt;
    return;
  }
  v.path = null;
  // прибытие / работа
  switch (v.state) {
    case 'goto_chop': {
      const o = v.targetObj;
      if (!o || o.regrow > 0) { v.state = 'idle'; v.decideT = 0.3; break; }
      v.state = 'chop'; v.workT = Math.max(2, 4.5 - v.skill.chop * 0.4);
      break;
    }
    case 'chop': {
      v.workT -= dt;
      if (v.workT <= 0) {
        const o = v.targetObj;
        if (o && o.regrow === 0) {
          removeObject(o);
          const stump = addObject('stump', o.x, o.y);
          // пень через пару дней снова деревом
          setTimeout(() => {}, 0);
          objects[objects.length - 1] = stump;
          // помечаем место под будущую регенерацию
          regrowQueue.push({ x: o.x, y: o.y, at: simTime + 2 * DAY_LEN });
          v.carry.wood += Math.ceil(3 * v.skill.chop);
          v.skill.chop = Math.min(3, v.skill.chop + 0.06);
          totalWood += 3;
          if (hasTrait(v, 'hardworking') && rng() < 0.4) think(v, 'Работать так работать! Ещё одно!');
          logEvent('🪓', `${v.name} срубил дерево (+3 🪵)`);
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
      const d = Math.hypot(other.x - v.x, other.y - v.y);
      if (d > 1.6) {
        // идём навстречу
        const p = astar(v.x, v.y, Math.floor(other.x), Math.floor(other.y));
        if (p && p.length > 1) { v.path = p.slice(0, Math.ceil(p.length / 2)); v.pathIdx = 0; }
        else if (p && p.length === 1) { v.path = p; v.pathIdx = 0; }
        else { v.state = 'idle'; v.decideT = 1; }
        break;
      }
      v.state = 'social'; v.workT = 3; v.socialWith = other.id;
      if (other.state !== 'social' && other.state !== 'goto_social') { other.state = 'social'; other.workT = 3; other.socialWith = v.id; think(other, pick(THOUGHTS.social)); }
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
        if (pendingBuild && pendingBuild.assigned === v && stocks.wood >= 25) {
          stocks.wood -= 25;
          addHut(pendingBuild.x, pendingBuild.y);
          logEvent('🏠', `${v.name} построил хижину! Деревня растёт.`);
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

// регенерация деревьев на месте пней
const regrowQueue = [];
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
  // камера
  const z = zoom;
  ctx.save();
  ctx.translate(cw / 2, ch / 2);
  ctx.scale(z, z);
  ctx.translate(-camX, -camY);
  // карта
  ctx.drawImage(mapCanvas, 0, 0);
  // объекты + жители, сортировка по y
  const drawList = [];
  for (const o of objects) drawList.push({ y: o.y, draw: () => drawObject(o) });
  for (const v of villagers) drawList.push({ y: v.y + 0.4, draw: () => drawVillager(v) });
  drawList.sort((a, b) => a.y - b.y);
  for (const d of drawList) d.draw();
  ctx.restore();
  // ночь
  const night = nightAmount();
  if (night > 0) {
    ctx.fillStyle = `rgba(16,20,52,${(night * 0.52).toFixed(3)})`;
    ctx.fillRect(0, 0, cw, ch);
    // свет костра и окон
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
  // пузыри мыслей (в экранных координатах)
  for (const v of villagers) {
    if (v.thought && simTime < v.thoughtUntil) {
      const sx = (v.x * TILE - camX) * z + cw / 2;
      const sy = (v.y * TILE - 18 - camY) * z + ch / 2;
      drawBubble(sx, sy, v.thought, v === selected);
    }
  }
  // ночь: zZ над спящими
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
    case 'tree': {
      ctx.drawImage(spr.tree[o.variant % 3], x - 1, y - 6); break;
    }
    case 'pine': ctx.drawImage(spr.pine[o.variant % 3], x - 1, y - 6); break;
    case 'bush': ctx.drawImage(spr.bush[o.depleted ? 1 : 0], x - 1, y + 2); break;
    case 'stone': ctx.drawImage(spr.stone, x, y + 1); break;
    case 'flower': ctx.drawImage(spr.flower, x + 1, y + 1); break;
    case 'stump': ctx.drawImage(spr.stump, x + 1, y + 4); break;
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
      // пламя
      const f = Math.sin(performance.now() / 90 + o.id) ;
      const h2 = 5 + f * 1.5;
      ctx.fillStyle = 'rgb(255,120,30)';
      ctx.fillRect(x + 2, y + 3 - h2, 4, h2);
      ctx.fillStyle = 'rgb(255,200,60)';
      ctx.fillRect(x + 3, y + 4 - h2 * 0.6, 2, h2 * 0.6);
      break;
    }
  }
}

function drawVillager(v) {
  const x = v.x * TILE - 4, y = v.y * TILE - 6;
  if (v === selected) {
    ctx.strokeStyle = 'rgba(140,120,255,0.9)';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(x - 1.5, y - 1.5, 11, 16.5);
  }
  const moving = v.path && v.pathIdx < v.path.length;
  const frame = moving && Math.floor((v.animT || 0) * 6) % 2 ? 1 : 0;
  const set = v.facing >= 0 ? spr.villagerFrames[v.bodyIdx] : spr.villagerFlip[v.bodyIdx];
  ctx.drawImage(set[frame], Math.round(x), Math.round(y));
  // имя при зуме
  if (zoom >= 2) {
    ctx.font = '4px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textAlign = 'center';
    ctx.fillText(v.name, x + 4, y - 1);
    ctx.textAlign = 'left';
  }
  // статус-иконка
  if (v.state === 'chop') drawTool(x, y, '🪓');
  if (v.state === 'sleep') { /* zZ рисуется отдельно */ }
}
function drawTool(x, y, icon) {
  ctx.font = '6px sans-serif';
  ctx.fillText(icon, x + 9, y + 6);
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
  // хвостик
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
    eat: 'ест', sleep: 'спит 😴', social: 'болтает', build: 'строит дом',
    goto_chop: 'идёт к дереву', goto_forage: 'идёт к кустам', goto_deposit: 'несёт запасы',
    goto_eat: 'идёт поесть', goto_sleep: 'идёт спать', goto_social: 'идёт болтать',
    goto_build: 'идёт на стройку', goto_camp: 'приходит в деревню'
  };
  const act = stateLabels[v.state] || v.state;
  const carry = [];
  if (v.carry.wood) carry.push(`🪵 ${v.carry.wood}`);
  if (v.carry.berries) carry.push(`🫐 ${v.carry.berries}`);
  const thoughtsHtml = v.thoughts.slice(0, 6).map(t => {
    const day = Math.floor(t.t / DAY_LEN) + 1;
    const hh = String(Math.floor(phase2(t.t) * 24)).padStart(2, '0');
    return `<div class="thought">«${t.text}» <span class="thought-time">Д${day} ${hh}:00</span></div>`;
  }).join('');
  panelEl.innerHTML = `
    <div class="vp-head">
      <canvas class="vp-portrait" id="vpPortrait" width="48" height="48"></canvas>
      <div>
        <div class="vp-name">${v.name}</div>
        <div class="vp-traits">${v.traits.map(t => t.label).join(' · ')}</div>
      </div>
      <button class="vp-close" id="vpClose">✕</button>
    </div>
    <div class="vp-action">Сейчас: <b>${act}</b></div>
    <div class="vp-bars">
      ${bar('Сытость', n.hunger, '#e0a44c')}
      ${bar('Энергия', n.energy, '#5cb85c')}
      ${bar('Общение', n.social, '#7c8cff')}
    </div>
    <div class="vp-carry">${carry.length ? 'Несёт: ' + carry.join(', ') : 'Руки свободны'}</div>
    <div class="vp-thoughts">${thoughtsHtml || '<span style="opacity:.5">Пока думает о чём-то своём…</span>'}</div>
  `;
  const portrait = document.getElementById('vpPortrait');
  const g = portrait.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#171b28';
  g.fillRect(0, 0, 48, 48);
  const set = spr.villagerFrames[v.bodyIdx];
  // крупная голова: увеличить верх спрайта 8×7 → 48×42
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
  statsEl.innerHTML = `День <b>${day}</b> <span class="dim">${hh}:${mm} ${phaseName}</span>
    &nbsp;·&nbsp; 👥 <b>${villagers.length}</b>
    &nbsp;·&nbsp; 🪵 <b>${stocks.wood}</b>
    &nbsp;·&nbsp; 🫐 <b>${stocks.berries}</b>
    &nbsp;·&nbsp; 🏠 <b>${huts.length}</b>
    &nbsp;·&nbsp; <span class="dim">сид ${seed}</span>`;
}

// ── Ввод: пан/зум/выбор ───────────────────────────────────────────
let pointers = new Map();
let dragMoved = 0, lastPinch = 0;
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
    const oldD = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
    const newD = Math.hypot((arr[0].x === p.x ? p2.x : arr[0].x) - (arr[0].x === p.x ? arr[1].x : p2.x),
      (arr[0].y === p.y ? p2.y : arr[0].y) - (arr[0].y === p.y ? arr[1].y : p2.y));
    if (oldD > 0 && newD > 0) { zoom = Math.max(0.8, Math.min(5, zoom * newD / oldD)); clampCam(); }
  }
  p.x = e.clientX; p.y = e.clientY;
});
function endPointer(e) {
  if (pointers.has(e.pointerId) && pointers.size === 1 && dragMoved < 8) {
    // клик → выбор жителя
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
    const sdt = dt * simSpeed;
    updateSim(Math.min(0.25, sdt));
    processRegrow();
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
requestAnimationFrame(loop);
