import {Resvg} from '@resvg/resvg-js';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
const fonts = ['brand/fonts/SpaceGrotesk.ttf','brand/fonts/SpaceGroteskMedium.ttf','brand/fonts/JetBrainsMono.ttf'].filter(existsSync);
const render = (svgPath, out, width) => {
  const svg = readFileSync(svgPath, 'utf8');
  const r = new Resvg(svg, {fitTo: {mode: 'width', value: width}, font: {fontFiles: fonts, loadSystemFonts: true, defaultFontFamily: 'Space Grotesk'}});
  writeFileSync(out, r.render().asPng());
  console.log('wrote', out);
};
render('brand/mark.svg', 'public/icon-512.png', 512);
render('brand/mark.svg', 'public/apple-touch-icon.png', 180);
render('brand/mark.svg', 'public/icon-192.png', 192);
render('brand/og.svg', 'public/og.png', 1200);
