// Тест v3.7: шахта с камнем, чат, признание, ночь, роды
global.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, addEventListener: ()=>{} };
global.document = {
  createElement: () => ({ getContext: () => new Proxy({}, { get: () => () => {} }), width: 0, height: 0, style: {} }),
  getElementById: () => ({ getContext: () => new Proxy({}, { get: () => () => {} }), style: {}, innerHTML: '', prepend: ()=>{}, children: { length: 0 }, onclick: null, addEventListener: ()=>{}, classList: { add: ()=>{}, remove: ()=>{}, toggle: ()=>{} }, appendChild: ()=>{}, value: '', scrollTop: 0, scrollHeight: 0, textContent: '' }),
  body: { classList: { add: ()=>{}, remove: ()=>{}, toggle: ()=>{} } },
  addEventListener: () => {},
};
global.requestAnimationFrame = () => {};
global.performance = { now: () => 0 };
let src = require('fs').readFileSync('game.js', 'utf8').replace(/requestAnimationFrame\(loop\);/, '');
src += ';globalThis.__T__ = { updateSim, DAY_LEN, get P(){return P}, startLifeGame, lifeGo, startLifeAction, finishLifeAction, get villagers(){return villagers}, get objects(){return objects}, objAt, key, TILE, mine: null, get stocks(){return stocks}, updatePlayer, llmChatReply, chatSendMsg, lifeConfess, lifeNight, makePlayerChild, lifeGive, get LLM(){return LLM}, get simTime(){return simTime}, cannedReply };';
eval(src);
const T = globalThis.__T__;
let bad = 0;

T.startLifeGame('m');
const P = T.P;
console.log('1) имя игрока:', P.name, '| chats:', JSON.stringify(P.chats).length >= 2 ? 'ok' : 'НЕТ');
if (!P.name) { bad++; console.log('  ОШИБКА: нет имени'); }
if (P.partnerId !== 0) { bad++; console.log('  ОШИБКА: partnerId'); }

// --- шахта: руда + камень ---
const mine = T.objects.find(o => o.type === 'mine');
const st0 = P.inv.stone, or0 = P.inv.ore;
P.x = mine.x + 1.5; P.y = mine.y + 0.5; P.pending = null; P.path = null;
T.startLifeAction({ kind: 'ore', ox: mine.x, oy: mine.y });
P.busyT = 0.001;
// вручную дожимаем busyT через updatePlayer не нужен — вызовем finish напрямую
T.finishLifeAction(P.busyKind); P.busyKind = null;
console.log('2) шахта: камень', P.inv.stone - st0, '| руда', P.inv.ore - or0);
if (P.inv.stone - st0 < 1 || P.inv.ore - or0 < 1) { bad++; console.log('  ОШИБКА: шахта не даёт камень/руду'); }

// --- отношения: подарки ---
const v = T.villagers.find(x => !x.isChild && x.id !== P.momId && x.id !== P.dadId);
v.relP = 20;
P.inv.berries = 10;
T.lifeGive(v.id);
console.log('3) после ягод симпатия:', v.relP);
if (v.relP !== 26) { bad++; console.log('  ОШИБКА: симпатия не выросла'); }

// --- признание при <50 отказ ---
T.lifeConfess(v.id);
console.log('4) признание при 26:', P.partnerId === v.id ? 'НЕДОЛЖНО' : 'отказ ✓');
if (P.partnerId === v.id) { bad++; }

// --- признание при 50+ успех ---
v.relP = 55;
T.lifeConfess(v.id);
console.log('5) признание при 55:', P.partnerId === v.id ? 'пара ✓' : 'ОШИБКА');
if (P.partnerId !== v.id) { bad++; }

// --- ночь + роды ---
T.lifeNight(v.id);
setTimeout(() => {
  if (v.pregUntil) console.log('6) ночь: беременность запланирована ✓ (до', v.pregUntil.toFixed(0) + ')');
  else { console.log('6) ночь: без беременности (шанс 55%) — ок'); }
  if (v.pregUntil) {
    // проматываем время до родов: двигаем simTime нельзя, крутим updateSim циклами
    let i = 0;
    while (v.pregUntil && i < 5000) { T.updateSim(0.5); i++; }
    const baby = T.villagers.find(x => x.isChild && x.name.startsWith('Малыш ' + P.name[0]));
    console.log('7) роды:', baby ? baby.name + ' ✓' : 'НЕ РОДИЛСЯ');
    if (!baby) { bad++; }
  }
  console.log(bad === 0 ? 'ВСЁ ЧИСТО' : 'ОШИБОК: ' + bad);
  process.exit(bad === 0 ? 0 : 1);
}, 3200);
