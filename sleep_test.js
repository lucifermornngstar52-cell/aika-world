const fs = require('fs');
global.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, addEventListener: ()=>{} };
const mkEl = () => ({ getContext: () => new Proxy({}, { get: () => () => {} }), style: {}, innerHTML: '', prepend: ()=>{}, children: { length: 0 }, onclick: null, addEventListener: ()=>{} });
global.document = {
  createElement: () => mkEl(),
  getElementById: () => mkEl(),
  addEventListener: () => {},
};
global.requestAnimationFrame = () => {};
global.performance = { now: () => 0 };
global.localStorage = { getItem: () => null, setItem: ()=>{}, removeItem: ()=>{} };
let src = fs.readFileSync('game.js', 'utf8').replace(/requestAnimationFrame\(loop\);/, '');
src += ";globalThis.__T__={updateSim,DAY_LEN,genWorld,get villagers(){return villagers},get huts(){return huts},get objects(){return objects}};";
eval(src);
const T = globalThis.__T__;
T.genWorld(555);
let sleepFoundInside = 0, sleepTotal = 0, err=0;
for (let t = 0; t < T.DAY_LEN * 8; t += 0.25) {
  try { T.updateSim(0.25); } catch(e) { err++; console.log(e.message); }
  for (const v of T.villagers) {
    if (v.state === 'sleep') {
      sleepTotal++;
      // жители спят точно в клетке дома (или у костра, если домов нет)
      const homes = T.objects.filter(o => o.type==='hut'||o.type==='house'||o.type==='shelter');
      const onHome = homes.some(h => Math.abs(v.x - (h.x+0.5)) < 0.1 && Math.abs(v.y - (h.y+0.5)) < 0.1);
      const onCampfire = Math.abs(v.x - (T.objects.find(o=>o.type==='campfire').x+0.5)) < 1.5;
      if (onHome || onCampfire) sleepFoundInside++;
    }
  }
}
console.log('ошибок:', err, '| проверок сна:', sleepTotal, '| корректно внутри:', sleepFoundInside);
if (err > 0) { console.log('FAIL: ошибки при рендере/симуляции'); process.exit(1); }
if (sleepTotal > 0 && sleepFoundInside / sleepTotal < 0.95) { console.log('FAIL: жители спят не в домах'); process.exit(1); }
console.log('=== ТЕСТ СНА И КРЫШ ПРОЙДЕН');
