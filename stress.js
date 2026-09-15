global.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, addEventListener: ()=>{} };
global.document = {
  createElement: () => ({ getContext: () => new Proxy({}, { get: () => () => {} }), width: 0, height: 0, style: {} }),
  getElementById: () => ({ getContext: () => new Proxy({}, { get: () => () => {} }), style: {}, innerHTML: '', prepend: ()=>{}, children: { length: 0 }, onclick: null, addEventListener: ()=>{} }),
};
global.requestAnimationFrame = () => {};
global.performance = { now: () => 0 };
let src = require('fs').readFileSync('game.js', 'utf8').replace(/requestAnimationFrame\(loop\);/, '');
src += ';globalThis.__T__ = { updateSim, DAY_LEN, SIM, genWorld, era, beds, cnt, ERAS, get villagers(){return villagers}, get stocks(){return stocks}, get farms(){return farms.length}, get pendingBuild(){return pendingBuild} };';
eval(src);
const T = globalThis.__T__;
let bad = 0;
for (const sd of [42, 777, 31337, 11111, 5555, 99, 2024, 8, 64, 100500]) {
  T.genWorld(sd);
  let errors = 0, firstErr = '', errT = 0;
  for (let t = 0; t < T.DAY_LEN * 20; t += 0.25) {
    try { T.updateSim(0.25); } catch (e) { if (errors++ === 0) { firstErr = e.stack.split('\n').slice(0,2).join('|'); errT = t; } }
  }
  // проверка инвариантов
  const inv = [];
  if (T.pendingBuild && !T.villagers.length) inv.push('pendingBuild без жителей');
  for (const v of T.villagers) {
    if (!isFinite(v.x) || !isFinite(v.y)) inv.push(v.name + ' NaN координаты');
    if (v.hp > 20.01) inv.push(v.name + ' hp>20');
  }
  if (T.stocks.wood < 0 || T.stocks.stone < 0 || T.stocks.berries < 0) inv.push('минус на складе');
  const status = errors === 0 && inv.length === 0 ? 'OK' : 'FAIL';
  if (status === 'FAIL') bad++;
  console.log('сид', String(sd).padEnd(7), status,
    'pop=' + T.villagers.length, 'era=' + T.era(), 'wood=' + T.stocks.wood,
    errors ? 'ERR=' + errors + ' t=' + Math.round(errT/T.DAY_LEN) + 'д: ' + firstErr : '',
    inv.join('; '));
}
console.log(bad === 0 ? '=== ВСЕ СИДЫ ЧИСТЫ' : '=== ПРОБЛЕМНЫХ СИДОВ: ' + bad);
