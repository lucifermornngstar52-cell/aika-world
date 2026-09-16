global.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, addEventListener: ()=>{} };
global.document = {
  createElement: () => ({ getContext: () => new Proxy({}, { get: () => () => {} }), width: 0, height: 0, style: {} }),
  getElementById: () => ({ getContext: () => new Proxy({}, { get: () => () => {} }), style: {}, innerHTML: '', prepend: ()=>{}, children: { length: 0 }, onclick: null, addEventListener: ()=>{}, classList: { add: ()=>{}, remove: ()=>{} }, appendChild: ()=>{}, value: '', scrollTop: 0, scrollHeight: 0, textContent: '' }),
  body: { classList: { add: ()=>{}, remove: ()=>{} } },
  addEventListener: () => {},
};
global.requestAnimationFrame = () => {};
global.performance = { now: () => 0 };
let src = require('fs').readFileSync('game.js', 'utf8').replace(/requestAnimationFrame\(loop\);/, '');
src += ';globalThis.__T__ = { get P(){return P}, startLifeGame, updateSim, DAY_LEN, llmChatReply, get villagers(){return villagers}, get simTime(){return simTime} };';
eval(src);
const T = globalThis.__T__;
T.startLifeGame('f');
const P = T.P;
const v = T.villagers.find(x => !x.isChild);
P.chats[v.id] = [];
P.partnerId = v.id; v.relP = 100;

(async () => {
  // 1) роды: форсируем беременность
  v.pregUntil = T.simTime + 5;
  let i = 0; const pop0 = T.villagers.length;
  while (v.pregUntil && i < 200) { T.updateSim(0.5); i++; }
  const baby = T.villagers.find(x => x.isChild && x.name.includes('Малыш'));
  console.log('роды:', baby ? baby.name + ' ✓ (жителей ' + pop0 + '→' + T.villagers.length + ')' : 'НЕ РОДИЛСЯ ✗');
  if (!baby) process.exit(1);

  // 2) живой ИИ-ответ в чате
  const reply = await T.llmChatReply(v, 'Привет! Пойдём с тобой на рыбалку завтра?');
  console.log('ИИ-чат (' + v.name + '):', reply);
  process.exit(reply && reply.length > 3 ? 0 : 1);
})();
