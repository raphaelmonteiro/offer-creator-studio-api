import * as sharp from 'sharp';

export interface Panel {
  label: string[];
  png: Buffer;
}

const HEIGHT = 420;
const LABEL_H = 58;
const GAP = 6;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Tira lado a lado: cada painel reduzido à mesma altura, com rótulo de até 3 linhas no topo. */
export async function makeStrip(panels: Panel[], file: string): Promise<void> {
  const rendered = await Promise.all(
    panels.map(async (p) => {
      const img = await sharp(p.png).resize({ height: HEIGHT }).png().toBuffer();
      const meta = await sharp(img).metadata();
      return { ...p, img, w: meta.width as number };
    }),
  );
  const width = rendered.reduce((s, p) => s + p.w + GAP, 0) - GAP;
  const composites: sharp.OverlayOptions[] = [];
  let x = 0;
  for (const p of rendered) {
    const lines = p.label
      .map(
        (l, i) =>
          `<text x="4" y="${15 + i * 17}" font-size="14" fill="#fff" font-family="monospace">${esc(l)}</text>`,
      )
      .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(p.w, 60)}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#222"/>${lines}</svg>`;
    composites.push(
      { input: Buffer.from(svg), left: x, top: 0 },
      { input: p.img, left: x, top: LABEL_H },
    );
    x += p.w + GAP;
  }
  await sharp({ create: { width, height: HEIGHT + LABEL_H, channels: 3, background: '#888' } })
    .composite(composites)
    .png()
    .toFile(file);
}
