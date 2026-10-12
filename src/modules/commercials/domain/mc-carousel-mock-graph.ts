import { ASSEMBLY_FPS, escapeDrawtextText } from './mc-assembly-graph';
import {
  carouselDurationS,
  carouselFractionsToPx,
  carouselPresetLayout,
  CarouselPxRect,
  MC_CAROUSEL_TOKENS,
  OfferCarouselProps,
} from './mc-offer-carousel-props';
import {
  buildTalkingArtComposeArgs,
  ComposeGraphInput,
  ComposePass,
  ffmpegColor,
} from './mc-talking-art-graph';

/**
 * Renderizador MOCK do F2 em ffmpeg (tarefa 6.5, `MC_PIPELINE_PROVIDER=mock`):
 * produz um MP4 de verdade a partir das MESMAS props da composição Remotion,
 * para o e2e mock entregar um vídeo F2 de ponta a ponta sem navegador. Não
 * imita a composição pixel a pixel — é um "slide" por oferta:
 *
 * - passe `speech` = o grafo do F1 (`buildTalkingArtComposeArgs`) sobre um
 *   quadro liso da cor de marca, com cada clipe conformado na JANELA do
 *   personagem (as frações das props) nos instantes das falas e o TTS mixado;
 * - passe `cards` = cartela final (último quadro clonado por
 *   `endcardPaddingS`), caixa branca do card na região do preset e, em cada
 *   intervalo de card (entrada até a entrada do seguinte, como
 *   `computeCardTimeline` do pacote), nome/preço/preço anterior/badge da
 *   oferta em `drawtext`; abertura e fechamento mostram o nome da marca; com
 *   `captions`, a fala em páginas de até 32 caracteres na faixa de legendas.
 *
 * Funções PURAS: o `MockCarouselRenderer` só executa os passes.
 */

/** Rótulo/saída de cada passe; o renderizador executa na ordem. */
export interface MockCarouselPlan {
  passes: ComposePass[];
  output: string;
  /** Duração esperada (ms): quadros da composição (falas + silêncios + cartela). */
  expectedDurationMs: number;
  windowPx: CarouselPxRect;
  cardPx: CarouselPxRect;
  /** Intervalos dos slides (s) — abertura, ofertas, fechamento (diagnóstico/teste). */
  slides: Array<{ kind: string; id: string; startS: number; endS: number }>;
}

/** Máximo de caracteres por página de legenda do mock (linhas curtas, sem quebra no drawtext). */
export const MC_MOCK_CAPTION_PAGE_CHARS = 32;

const fmt = (n: number) => Number(Math.max(0, n).toFixed(3)).toString();

/** Fonte que cabe na largura (aproximação DejaVu: ~0,62 do corpo por glifo). */
export function fitFontPx(text: string, maxWidth: number, maxPx: number, minPx = 18): number {
  const chars = Math.max(1, [...text].length);
  return Math.max(minPx, Math.min(maxPx, Math.floor(maxWidth / (chars * 0.62))));
}

/**
 * Texto do drawtext: `escapeDrawtextText` + `%` com DUAS barras — o parser de
 * opções do filtro consome uma barra fora das aspas e o drawtext expandiria o
 * `%` restante ("-18%" sumia com "Stray %"; medido no ffmpeg 6.1).
 */
export function mockDrawtextText(text: string): string {
  // escapeDrawtextText já entrega o `%` com as duas barras que o ffmpeg exige.
  return escapeDrawtextText(text);
}

function draw(
  text: string,
  opts: {
    x: string;
    y: number | string;
    size: number;
    color: string;
    from: number;
    to: number;
    box?: string;
  },
): string {
  const box = opts.box ? `:box=1:boxcolor=${opts.box}:boxborderw=12` : '';
  return (
    `drawtext=text='${mockDrawtextText(text)}':fontsize=${opts.size}:fontcolor=${opts.color}` +
    `${box}:x=${opts.x}:y=${opts.y}:enable='between(t,${fmt(opts.from)},${fmt(opts.to)})'`
  );
}

/** "R$ 24,90" (+ unidade) — o texto do card vem da string congelada, sem aritmética. */
function priceLabel(price: string, unit?: string): string {
  const u = unit?.trim();
  return `R$ ${price}${u ? (u.startsWith('/') ? ` ${u}` : ` /${u}`) : ''}`;
}

/** Intervalos dos cards: entrada termina na 1ª palavra (≤ 0,45 s antes); fica até a entrada do seguinte. */
export function mockSlideWindows(
  props: OfferCarouselProps,
  totalS: number,
): MockCarouselPlan['slides'] {
  const starts = props.lines.map((line, i) => {
    if (i === 0 && line.kind === 'opening') return 0;
    const anchor = line.words[0]?.startS ?? line.startS;
    return Math.max(0, anchor - MC_CAROUSEL_TOKENS.cardEntryS);
  });
  return props.lines.map((line, i) => ({
    kind: line.kind,
    id: line.kind === 'offer' ? (line.offerId ?? line.id) : line.id,
    startS: starts[i],
    endS: i + 1 < starts.length ? starts[i + 1] : totalS,
  }));
}

/** Páginas de legenda por fala (palavras com tempos absolutos), até 32 caracteres cada. */
export function mockCaptionPages(
  props: OfferCarouselProps,
): Array<{ text: string; startS: number; endS: number }> {
  const pages: Array<{ text: string; startS: number; endS: number }> = [];
  for (const line of props.lines) {
    let current: { words: string[]; startS: number; endS: number } | null = null;
    for (const word of line.words) {
      const candidate: string = current ? `${current.words.join(' ')} ${word.text}` : word.text;
      if (current && candidate.length > MC_MOCK_CAPTION_PAGE_CHARS) {
        pages.push({ text: current.words.join(' '), startS: current.startS, endS: current.endS });
        current = null;
      }
      if (!current) current = { words: [word.text], startS: word.startS, endS: word.endS };
      else {
        current.words.push(word.text);
        current.endS = word.endS;
      }
    }
    if (current) {
      pages.push({ text: current.words.join(' '), startS: current.startS, endS: current.endS });
    }
  }
  // nunca duas páginas na tela; mínimo legível de 0,4 s quando há espaço
  return pages.map((page, i) => {
    const next = pages[i + 1];
    const endS = Math.max(page.endS, page.startS + 0.4);
    return { ...page, endS: next ? Math.min(endS, next.startS) : endS };
  });
}

/**
 * Plano do mock: `clipPaths[i]` é o arquivo LOCAL do clipe `props.character.clips[i]`.
 * `tempDir` recebe os intermediários; a saída é `<tempDir>/carousel.mp4`.
 */
export function buildMockCarouselPlan(input: {
  props: OfferCarouselProps;
  clipPaths: string[];
  tempDir: string;
}): MockCarouselPlan {
  const { props, clipPaths, tempDir } = input;
  if (clipPaths.length !== props.character.clips.length || clipPaths.length === 0) {
    throw new Error('render mock: um arquivo local por clipe do personagem');
  }
  const { width: W, height: H } = props;
  const totalS = carouselDurationS(props);
  const speechEndS = Math.max(...props.character.clips.map((c) => c.endS));
  const tailS = Math.max(0, totalS - speechEndS);
  const preset = carouselPresetLayout({
    width: W,
    height: H,
    tileRatio: props.character.tileRatio,
    preset: props.layoutPreset,
    captions: props.captions,
  });
  const cardPx = props.cardBox ? carouselFractionsToPx(props.cardBox, W, H) : preset.card;
  const windowPx = carouselFractionsToPx(props.character.window, W, H);

  // passe 1: personagem na janela + TTS (grafo do F1 sobre quadro liso da cor de marca)
  const speechOut = `${tempDir}/speech.mp4`;
  const composeInput: ComposeGraphInput = {
    format: 'offer_carousel',
    aspectRatio: `${W}x${H}`,
    width: W,
    height: H,
    backgroundArtPath: null,
    window: props.character.window,
    logoFace: false,
    backgroundColor: props.brand.primaryColor,
    clips: props.character.clips.map((clip, i) => ({
      sceneId: clip.lineId ?? `clip-${i}`,
      path: clipPaths[i],
      startS: clip.startS,
      endS: clip.endS,
    })),
    gapMs: 0,
    captionsEnabled: false,
    endcard: null,
  };

  // passe 2: cartela, card, textos dos slides e legendas
  const slides = mockSlideWindows(props, totalS);
  const offersById = new Map(props.offers.map((o) => [o.id, o]));
  const pad = Math.round(Math.min(cardPx.width, cardPx.height) * 0.06);
  const innerW = cardPx.width - 2 * pad;
  const cx = `${cardPx.x}+(${cardPx.width}-text_w)/2`;
  const filters: string[] = [];
  if (tailS > 0) filters.push(`tpad=stop_mode=clone:stop_duration=${fmt(tailS)}`);
  filters.push(
    `drawbox=x=${cardPx.x}:y=${cardPx.y}:w=${cardPx.width}:h=${cardPx.height}:` +
      `color=white@1:t=fill`,
  );
  const brandLabel = props.brand.name?.trim() || 'Ofertas';
  for (const slide of slides) {
    if (slide.endS <= slide.startS) continue;
    if (slide.kind !== 'offer') {
      const title = slide.kind === 'opening' ? brandLabel : 'Aproveite!';
      filters.push(
        draw(title, {
          x: cx,
          y: Math.round(cardPx.y + cardPx.height * 0.42),
          size: fitFontPx(title, innerW, Math.round(cardPx.width / 8)),
          color: ffmpegColor(props.brand.primaryColor),
          from: slide.startS,
          to: slide.endS,
        }),
      );
      continue;
    }
    const offer = offersById.get(slide.id);
    if (!offer) continue;
    const name = [...offer.name].slice(0, 28).join('');
    const price = priceLabel(offer.price, offer.unit);
    if (offer.badge) {
      filters.push(
        draw(offer.badge, {
          x: `${cardPx.x + pad}`,
          y: cardPx.y + pad,
          size: fitFontPx(offer.badge, Math.round(innerW * 0.7), Math.round(cardPx.width / 14)),
          color: 'white',
          box: ffmpegColor(props.brand.primaryColor),
          from: slide.startS,
          to: slide.endS,
        }),
      );
    }
    filters.push(
      draw(name, {
        x: cx,
        y: Math.round(cardPx.y + cardPx.height * 0.36),
        size: fitFontPx(name, innerW, Math.round(cardPx.width / 11)),
        color: '0x17171C',
        from: slide.startS,
        to: slide.endS,
      }),
    );
    if (offer.originalPrice) {
      const original = `de R$ ${offer.originalPrice}`;
      filters.push(
        draw(original, {
          x: cx,
          y: Math.round(cardPx.y + cardPx.height * 0.52),
          size: fitFontPx(original, innerW, Math.round(cardPx.width / 16)),
          color: '0x5C6070',
          from: slide.startS,
          to: slide.endS,
        }),
      );
    }
    filters.push(
      draw(price, {
        x: cx,
        y: Math.round(cardPx.y + cardPx.height * 0.62),
        size: fitFontPx(price, innerW, Math.round(cardPx.width / 6)),
        color: ffmpegColor(props.brand.primaryColor),
        from: slide.startS,
        to: slide.endS,
      }),
    );
  }
  if (props.captions && preset.captions) {
    const band = preset.captions;
    for (const page of mockCaptionPages(props)) {
      filters.push(
        draw(page.text, {
          x: `${band.x}+(${band.width}-text_w)/2`,
          y: `${band.y}+(${band.height}-text_h)/2`,
          size: fitFontPx(page.text, band.width, 60, 24),
          color: 'white',
          box: 'black@0.55',
          from: page.startS,
          to: page.endS,
        }),
      );
    }
  }
  filters.push('format=yuv420p');

  const output = `${tempDir}/carousel.mp4`;
  const T = fmt(totalS);
  const cardsArgs = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    speechOut,
    '-vf',
    filters.join(','),
    '-af',
    `apad=pad_dur=${fmt(tailS + 0.1)},aformat=sample_rates=48000:channel_layouts=stereo`,
    '-t',
    T,
    '-r',
    String(ASSEMBLY_FPS),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    output,
  ];
  const speechMs = Math.round(speechEndS * 1000);
  return {
    passes: [
      {
        label: 'speech',
        args: buildTalkingArtComposeArgs(composeInput, speechOut),
        durationMs: speechMs,
        output: speechOut,
      },
      { label: 'cards', args: cardsArgs, durationMs: Math.round(totalS * 1000), output },
    ],
    output,
    expectedDurationMs: Math.round(totalS * 1000),
    windowPx,
    cardPx,
    slides,
  };
}
