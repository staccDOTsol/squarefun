import {Resvg} from '@resvg/resvg-js';
import {readFileSync, writeFileSync} from 'node:fs';
const fonts = ['brand/fonts/SpaceGrotesk.ttf','brand/fonts/SpaceGroteskMedium.ttf','brand/fonts/JetBrainsMono.ttf'];
const render = (svgPath, out, width) => {
  const r = new Resvg(readFileSync(svgPath, 'utf8'), {fitTo: {mode: 'width', value: width}, font: {fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: 'Space Grotesk'}});
  writeFileSync(out, r.render().asPng());
};
render('brand/mark.svg', 'brand/square-mark-2048.png', 2048);
render('brand/og.svg', 'brand/square-og-2400.png', 2400);
console.log('ok');
