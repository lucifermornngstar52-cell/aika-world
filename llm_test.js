// Тест LLM-модуля: живые мысли жителей через Groq + офлайн-фолбэк
global.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, addEventListener: ()=>{} };
global.document = {
  createElement: () => ({ getContext: () => new Proxy({}, { get: () => () => {} }), width: 0, height: 0, style: {} }),
  getElementById: () => ({ getContext: () => new Proxy({}, { get: () => () => {} }), style: {}, innerHTML: '', prepend: ()=>{}, children: { length: 0 }, onclick: null, addEventListener: ()=>{}, checked: true, value: '' }),
  body: { classList: { add: ()=>{}, remove: ()=>{} } },
  addEventListener: () => {},
  hidden: false,
};
global.localStorage = { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = v; }, removeItem(k) { delete this._s[k]; } };
global.requestAnimationFrame = () => {};
global.performance.now = () => 0; // не подменяем весь объект — fetch'у нужен настоящий Performance
let src = require('fs').readFileSync('game.js', 'utf8').replace(/requestAnimationFrame\(loop\);/, '');
src += ';globalThis.__T__ = { startLifeGame, genWorld, get P(){return P}, get villagers(){return villagers}, get LLM(){return LLM}, llmVillagerThought, llmTick, tryLlmDesire, decide, DAY_LEN, updateSim, get mode(){return mode} };';
eval(src);
const T = globalThis.__T__;
let bad = 0;

(async () => {
  // 1. генерация мира + жизнь
  T.startLifeGame('m');
  console.log('LLM включён:', T.LLM.on, '| ключ вшит:', (T.LLM.key || '').startsWith('gsk_'));

  // 2. реальный запрос мысли у первого бодрого жителя
  const v = T.villagers.find(x => x.state !== 'sleep') || T.villagers[0];
  try {
    const r = await T.llmVillagerThought(v);
    console.log('МЫСЛЬ ✨:', r.thought, '| хочет:', r.want);
    if (!r.thought || r.thought.length > 120) { bad++; console.log('FAIL: мысль пустая или длинная'); }
    if (!['berries','wood','stone','chat','sleep','hunt','wander'].includes(r.want)) { bad++; console.log('FAIL: want вне списка: ' + r.want); }
  } catch (e) { bad++; console.log('FAIL запрос: ' + e.message); }

  // 3. желание внедряется в decide()
  try {
    const v2 = T.villagers.find(x => !x.isChild);
    v2.needs.hunger = 80; v2.needs.energy = 80; // базовые потребности не мешают
    v2.llmWant = 'wood';
    v2.llmWantUntil = 1e9;
    T.decide(v2);
    const wentChopping = v2.state === 'goto_chop' || v2.state === 'chop';
    console.log('желание wood → житель пошёл:', v2.state, wentChopping ? 'OK' : 'FAIL');
    if (!wentChopping) bad++;
  } catch (e) { bad++; console.log('FAIL desire: ' + e.stack.split('\n')[0]); }

  // 4. llmTick не падает и ставит таймер
  try {
    T.LLM.t = 0; T.LLM.busy = false; T.LLM.fail = 0; T.LLM.on = true;
    T.llmTick(1);
    console.log('llmTick запущен: busy=' + T.LLM.busy);
    await new Promise(res => setTimeout(res, 2500));
    console.log('после ответа: busy=' + T.LLM.busy + ', след. через ' + Math.round(T.LLM.t) + 'с, fail=' + T.LLM.fail);
    if (T.LLM.fail >= 3) { bad++; console.log('FAIL: LLM ошибки'); }
  } catch (e) { bad++; console.log('FAIL tick: ' + e.message); }

  // 5. битый ключ → ошибка ловится, fail растёт, игра живёт
  try {
    const oldKey = T.LLM.key;
    T.LLM.key = 'gsk_badkey'; T.LLM.fail = 0; T.LLM.t = 0; T.LLM.busy = false;
    T.llmTick(1);
    await new Promise(res => setTimeout(res, 2500));
    console.log('битый ключ: fail=' + T.LLM.fail + (T.LLM.fail > 0 ? ' OK' : ' FAIL'));
    if (T.LLM.fail === 0) bad++;
    T.LLM.key = oldKey; T.LLM.fail = 0;
  } catch (e) { bad++; console.log('FAIL badkey: ' + e.message); }

  // 6. сим 2 дня с LLM-хуком желания в decide
  let err = '';
  for (let t = 0; t < T.DAY_LEN * 2; t += 0.25) {
    try { T.updateSim(0.25); } catch (e) { err = e.stack.split('\n')[0]; break; }
  }
  console.log('сим 2 дня:', err ? 'FAIL ' + err : 'OK');
  if (err) bad++;

  console.log(bad === 0 ? '=== ТЕСТ ЖИВОГО МОЗГА ПРОЙДЕН' : '=== ОШИБОК: ' + bad);
  process.exit(bad ? 1 : 0);
})();
