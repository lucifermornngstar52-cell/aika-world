const fs = require('fs');
// эмулируем px() и canvas для проверки геометрии крыш чисто математически
function checkRoof(rows, widthFn) {
  const widths = [];
  for (let row = 0; row < rows; row++) widths.push(widthFn(row));
  return widths;
}
// hut: rows=8, inset = 7-row, width = 18 - 2*inset
const hutW = checkRoof(8, row => 18 - 2 * (7 - row));
console.log('крыша хижины (ширина по рядам сверху-вниз):', hutW.join(','));
if (hutW[0] >= hutW[hutW.length-1]) { console.log('FAIL: верх крыши шире низа — всё ещё вверх ногами'); process.exit(1); }
console.log('ok: узко у конька (' + hutW[0] + '), широко у стен (' + hutW[hutW.length-1] + ')');

const houseW = checkRoof(7, row => 22 - 2 * (6 - row));
console.log('крыша дома:', houseW.join(','));
if (houseW[0] >= houseW[houseW.length-1]) { console.log('FAIL дом'); process.exit(1); }
console.log('ok: узко у конька (' + houseW[0] + '), широко у стен (' + houseW[houseW.length-1] + ')');
