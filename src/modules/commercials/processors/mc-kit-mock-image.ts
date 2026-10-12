import * as sharp from 'sharp';

/**
 * PNG sintético de personagem para o provider mock (MC_KIT_PROVIDER=mock):
 * fundo liso, cabeça redonda na caixa que o gate de boca mock devolve
 * (x 0,30 · y 0,15 · w 0,40 · h 0,40) e corpo saindo pela borda inferior —
 * o suficiente para o tile (recorte, guarda de borda, ≥ 720 px) rodar de
 * ponta a ponta sem gastar imagem.
 */
export async function mockCharacterImage(options: {
  background: string;
  color: string;
  label: string;
  width?: number;
  height?: number;
}): Promise<Buffer> {
  const width = options.width ?? 768;
  const height = options.height ?? 960;
  const headCx = width * 0.5;
  const headCy = height * 0.35;
  const headR = Math.min(width * 0.2, height * 0.2);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="${options.background}"/>` +
    `<rect x="${width * 0.35}" y="${height * 0.52}" width="${width * 0.3}" height="${height * 0.5}" rx="40" fill="${options.color}"/>` +
    `<circle cx="${headCx}" cy="${headCy}" r="${headR}" fill="${options.color}"/>` +
    `<ellipse cx="${headCx}" cy="${headCy + headR * 0.45}" rx="${headR * 0.35}" ry="${headR * 0.18}" fill="#222222"/>` +
    `<text x="${headCx}" y="${height * 0.95}" font-family="sans-serif" font-size="${Math.round(width * 0.04)}" fill="#333333" text-anchor="middle">${options.label}</text>` +
    `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
