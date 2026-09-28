import {Resvg} from '@resvg/resvg-js';
import {readFileSync, writeFileSync} from 'node:fs';
const render = (svgPath, out, width) => {
  const r = new Resvg(readFileSync(svgPath, 'utf8'), {fitTo: {mode: 'width', value: width}, font: {loadSystemFonts: false}});
  writeFileSync(out, r.render().asPng());
};
render('brand/circle.svg', 'brand/circle-512.png', 512);
render('brand/circle.svg', 'brand/circle-2048.png', 2048);
console.log('ok');
