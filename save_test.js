global.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, addEventListener: ()=>{} };
global.document = {
  createElement: () => ({ getContext: () => new Proxy({}, { get: () => () => {} }), width: 0, height: 0, style: {} }),
  getElementById: () => ({ getContext: () => new Proxy({}, { get: () => () => {} }), style: {}, innerHTML: '', prepend: ()=>{}, children: { length: 0 }, onclick: null, addEventListener: ()=>{} }),
  addEventListener: () => {},
};
global.requestAnimationFrame = () => {};
global.performance = { now: () => 0 };
let store = {};
global.localStorage = {
  setItem: (k, v) => { store[k] = v; },
  getItem: (k) => store[k] || null,
  removeItem: (k) => { delete store[k]; },
};
let src = require('fs').readFileSync('game.js', 'utf8').replace(/requestAnimationFrame\(loop\);/, '');
src += ';globalThis.__T__ = { updateSim, DAY_LEN, saveGame, loadGame, genWorld, get villagers(){return villagers}, get stocks(){return stocks}, get simTime(){return simTime}, get objects(){return objects}, get huts(){return huts} };';
eval(src);
const T = globalThis.__T__;
// прогон 6 дней
T.genWorld(777);
for (let t = 0; t < T.DAY_LEN * 6; t += 0.25) T.updateSim(0.25);
const pop = T.villagers.length, wood = T.stocks.wood, simT = T.simTime, objs = T.objects.length;
const names = T.villagers.map(v => v.name).join(',');
console.log('ДО СОХРАНЕНИЯ: pop=' + pop, 'wood=' + wood, 'simT=' + simT.toFixed(1), 'objs=' + objs);
// сохранить
T.saveGame();
console.log('сейв размер:', (store['aikaWorldSave'] || '').length, 'байт');
// изменить мир (ещё 3 дня) и загрузиться
for (let t = 0; t < T.DAY_LEN * 3; t += 0.25) T.updateSim(0.25);
const ok = T.loadGame();
console.log('ЗАГРУЗКА:', ok ? 'успех' : 'ПРОВАЛ');
console.log('ПОСЛЕ: pop=' + T.villagers.length + ' (было ' + pop + ')',
  'wood=' + T.stocks.wood + ' (было ' + wood + ')',
  'simT=' + T.simTime.toFixed(1) + ' (было ' + simT.toFixed(1) + ')',
  'objs=' + T.objects.length + ' (было ' + objs + ')');
const names2 = T.villagers.map(v => v.name).join(',');
console.log('имена совпадают:', names === names2 ? 'ДА' : 'НЕТ (' + names2 + ')');
// мир живёт после загрузки?
let err = 0;
for (let t = 0; t < T.DAY_LEN * 5; t += 0.25) { try { T.updateSim(0.25); } catch(e) { err++; } }
console.log('после загрузки 5 дней: ошибок=' + err, 'pop=' + T.villagers.length);
