const fs = require('fs');
const IDS = new Set(fs.readFileSync('/tmp/ids.txt','utf8').split('\n').filter(Boolean));
const mkEl = () => ({ getContext: () => new Proxy({}, { get: () => () => {} }), style: {}, innerHTML: '', prepend: ()=>{}, appendChild: ()=>{}, children: { length: 0 }, onclick: null, addEventListener: ()=>{}, classList: { add: ()=>{}, remove: ()=>{} } });
global.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, addEventListener: ()=>{}, PointerEvent: function(){} };
global.document = {
  createElement: () => mkEl(),
  getElementById: (id) => { if (!IDS.has(id)) { console.log('!!! getElementById("' + id + '") → NULL'); return null; } return mkEl(); },
  addEventListener: () => {},
};
global.requestAnimationFrame = () => {};
global.performance = { now: () => 0 };
global.localStorage = { getItem: () => null, setItem: ()=>{}, removeItem: ()=>{} };
let src = fs.readFileSync('game.js', 'utf8').replace(/requestAnimationFrame\(loop\);/, '');
try {
  eval(src);
  console.log('BOOT OK');
} catch (e) {
  console.log('CRASH:', e.message);
  console.log(e.stack.split('\n').slice(0,4).join('\n'));
}
