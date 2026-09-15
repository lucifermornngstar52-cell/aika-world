global.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, addEventListener: () => {} };
global.document = {
  createElement: () => ({ getContext: () => new Proxy({}, { get: () => () => {} }), width: 0, height: 0, style: {} }),
  getElementById: () => ({ getContext: () => new Proxy({}, { get: () => () => {} }), style: {}, innerHTML: '', prepend: () => {}, children: { length: 0 }, onclick: null, addEventListener: () => {} }),
};
global.requestAnimationFrame = () => {};
global.performance = { now: () => 0 };
let src = require('fs').readFileSync('game.js', 'utf8').replace(/requestAnimationFrame\(loop\);/, '');
src += ';globalThis.__T__ = { updateSim, DAY_LEN, SIM, genWorld, era, beds, cnt, ERAS, get villagers(){return villagers}, get monsters(){return monsters}, get stocks(){return stocks}, get farms(){return farms.length}, get gears(){return villagers.map(v=>v.name+"="+(v.tool||"-")+(v.spear?"+spear":""))} };';
eval(src);
const T = globalThis.__T__;
for (const sd of [42, 777, 31337]) {
  T.genWorld(sd);
  let errors = 0, firstErr = '';
  for (let t = 0; t < T.DAY_LEN * 30; t += 0.25) {
    try { T.updateSim(0.25); } catch (e) { if (errors++ === 0) firstErr = e.stack.split('\n').slice(0, 3).join('|'); }
  }
  console.log('=== сид', sd, 'ошибок:', errors, errors ? firstErr : '');
  console.log('эпоха:', T.ERAS[T.era()], '(' + T.era() + ') | койки:', T.beds(), '| население:', T.villagers.length);
  console.log('здания: 🏕' + T.cnt('shelter'), '🏠' + T.cnt('hut'), '🏡' + T.cnt('house'), '🌾' + T.farms);
  console.log('склад: 🪵' + T.stocks.wood, '🪨' + T.stocks.stone, '🫐' + T.stocks.berries);
  console.log('вооружение:', T.gears.slice(0, 8).join(', ') || 'голые руки');
  console.log('война: волн', T.SIM.monsterWaves, '| убито', T.SIM.monsterKills, '| потери', T.SIM.deaths, '| рождений', T.SIM.births, '| урожаев', T.SIM.harvests);
}
