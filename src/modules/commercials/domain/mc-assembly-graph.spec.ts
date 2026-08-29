import {
  assemblyDimensions,
  buildConcatArgs,
  buildConcatListContent,
  buildEndcardArgs,
  buildFinalizeArgs,
  buildMockMusicArgs,
  buildNormalizeArgs,
  buildPosterArgs,
  buildSealCues,
  buildTimedDrawtext,
  ENDCARD_DURATION_S,
  escapeDrawtextText,
  formatSealText,
  LOUDNORM_FILTER,
  MUSIC_DUCKING_FILTER,
  sealStyle,
} from './mc-assembly-graph';

describe('mc-assembly-graph — grafo puro da montagem (plano §5.1 etapa 6 / §5.4)', () => {
  describe('escapeDrawtextText', () => {
    it('escapa os metacaracteres do parser de filtro', () => {
      expect(escapeDrawtextText('Oferta: R$ 9,90')).toBe('Oferta\\: R$ 9,90');
      expect(escapeDrawtextText("D'Água")).toBe("D\\'Água");
      expect(escapeDrawtextText('100%')).toBe('100\\%');
      expect(escapeDrawtextText('a\\b')).toBe('a\\\\b');
    });

    it('quebra de linha vira espaço (selo é uma linha)', () => {
      expect(escapeDrawtextText('linha1\nlinha2')).toBe('linha1 linha2');
      expect(escapeDrawtextText('linha1\r\nlinha2')).toBe('linha1 linha2');
    });
  });

  describe('assemblyDimensions — formato do projeto (contrato v1-B1)', () => {
    it.each([
      ['9:16', 720, 1280],
      ['1:1', 960, 960],
      ['16:9', 1280, 720],
    ])('%s → %ix%i', (aspect, width, height) => {
      expect(assemblyDimensions(aspect)).toEqual({ width, height });
    });

    it('formato desconhecido/ausente cai em 9:16', () => {
      expect(assemblyDimensions(null)).toEqual({ width: 720, height: 1280 });
      expect(assemblyDimensions('4:3')).toEqual({ width: 720, height: 1280 });
    });
  });

  describe('buildNormalizeArgs', () => {
    it('normaliza para 720x1280@30 h264 yuv420p AAC 48k +faststart', () => {
      const args = buildNormalizeArgs({
        input: '/in.mp4',
        output: '/out.mp4',
        hasAudio: true,
        durationS: 10,
      });
      const joined = args.join(' ');
      expect(joined).toContain('scale=720:1280:force_original_aspect_ratio=decrease');
      expect(joined).toContain('pad=720:1280');
      expect(joined).toContain('fps=30,format=yuv420p');
      expect(joined).toContain('-c:v libx264');
      expect(joined).toContain('-movflags +faststart');
      expect(joined).toContain('-ar 48000');
      expect(args[args.length - 1]).toBe('/out.mp4');
      // com áudio próprio: sem anullsrc e mapeando 0:a
      expect(joined).not.toContain('anullsrc');
      expect(joined).toContain('-map 0:a:0');
    });

    it('clipe mudo ganha trilha de silêncio (anullsrc) mapeada do input 1', () => {
      const args = buildNormalizeArgs({
        input: '/in.mp4',
        output: '/out.mp4',
        hasAudio: false,
        durationS: 8,
      });
      const joined = args.join(' ');
      expect(joined).toContain('anullsrc=r=48000:cl=stereo');
      expect(joined).toContain('-t 8');
      expect(joined).toContain('-map 1:a:0');
    });

    it('respeita o formato do projeto (1:1 e 16:9)', () => {
      const quadrado = buildNormalizeArgs({
        input: '/in.mp4',
        output: '/out.mp4',
        hasAudio: true,
        durationS: 5,
        ...assemblyDimensions('1:1'),
      }).join(' ');
      expect(quadrado).toContain('scale=960:960');
      expect(quadrado).toContain('pad=960:960');

      const paisagem = buildNormalizeArgs({
        input: '/in.mp4',
        output: '/out.mp4',
        hasAudio: true,
        durationS: 5,
        ...assemblyDimensions('16:9'),
      }).join(' ');
      expect(paisagem).toContain('scale=1280:720');
    });
  });

  describe('buildEndcardArgs — cartela final determinística (plano §5.4)', () => {
    it('2s de cor sólida + nome da loja centrado, com áudio de silêncio', () => {
      const args = buildEndcardArgs({ output: '/end.mp4', storeName: 'Mercado do Zé' });
      const joined = args.join(' ');
      expect(joined).toContain(`d=${ENDCARD_DURATION_S}`);
      expect(joined).toContain('color=c=0x1F2430:s=720x1280');
      expect(joined).toContain("drawtext=text='Mercado do Zé'");
      expect(joined).toContain('x=(w-text_w)/2:y=(h-text_h)/2');
      expect(joined).toContain('anullsrc=r=48000:cl=stereo');
      // mesmos parâmetros de encode dos clipes normalizados (o concat exige)
      expect(joined).toContain('-c:v libx264');
      expect(joined).toContain('-c:a aac');
      expect(joined).toContain('-ar 48000');
    });

    it('escapa o nome da loja e acompanha o formato', () => {
      const joined = buildEndcardArgs({
        output: '/end.mp4',
        storeName: "Empório D'Água: o melhor",
        ...assemblyDimensions('16:9'),
      }).join(' ');
      expect(joined).toContain("text='Empório D\\'Água\\: o melhor'");
      expect(joined).toContain('s=1280x720');
    });

    it('args completos (snapshot do contrato do passe)', () => {
      expect(buildEndcardArgs({ output: '/end.mp4', storeName: 'Loja' })).toMatchSnapshot();
    });
  });

  it('buildConcatListContent escapa aspas simples no formato do demuxer', () => {
    expect(buildConcatListContent(['/a/n1.mp4', "/a/d'agua.mp4"])).toBe(
      "file '/a/n1.mp4'\nfile '/a/d'\\''agua.mp4'\n",
    );
  });

  it('buildConcatArgs usa o demuxer com -c copy (clipes já uniformes)', () => {
    const joined = buildConcatArgs('/list.txt', '/concat.mp4').join(' ');
    expect(joined).toContain('-f concat -safe 0 -i /list.txt');
    expect(joined).toContain('-c copy');
  });

  describe('selos por produto (contrato v1-B1)', () => {
    it('formatSealText monta "NOME — R$ preço" sem duplicar o símbolo', () => {
      expect(formatSealText({ name: 'Café Pilão', price: '12,90' })).toBe('CAFÉ PILÃO — R$ 12,90');
      expect(formatSealText({ name: 'Arroz', price: 'R$ 19,90' })).toBe('ARROZ — R$ 19,90');
    });

    it('1 selo por cena, rotativo, entrando na SEGUNDA METADE da cena', () => {
      const cues = buildSealCues(
        [
          { idx: 0, startS: 0, endS: 6 },
          { idx: 1, startS: 6, endS: 16 },
          { idx: 2, startS: 16, endS: 20 },
        ],
        [
          { name: 'Café', price: '12,90' },
          { name: 'Arroz', price: '19,90' },
        ],
      );
      expect(cues).toEqual([
        { text: 'CAFÉ — R$ 12,90', startS: 3, endS: 6 },
        { text: 'ARROZ — R$ 19,90', startS: 11, endS: 16 },
        { text: 'CAFÉ — R$ 12,90', startS: 18, endS: 20 }, // rotação volta ao 1º
      ]);
    });

    it('sem produtos válidos → nenhum selo', () => {
      expect(buildSealCues([{ idx: 0, startS: 0, endS: 5 }], [])).toEqual([]);
      expect(buildSealCues([{ idx: 0, startS: 0, endS: 5 }], [{ name: ' ', price: '1' }])).toEqual(
        [],
      );
    });
  });

  it('buildTimedDrawtext liga o texto só na janela da cue (enable=between)', () => {
    const filter = buildTimedDrawtext(
      { text: 'CAFÉ — R$ 12,90', startS: 3, endS: 6 },
      sealStyle(720, 'CAFÉ — R$ 9,90'),
    );
    expect(filter).toContain("enable='between(t,3.00,6.00)'");
    expect(filter).toContain('box=1:boxcolor=black@0.55');
    expect(filter).toContain('x=(w-text_w)/2:y=h*0.72');
    expect(filter).not.toContain('fontfile'); // fonte default do container
  });

  describe('buildFinalizeArgs', () => {
    it('sem nada a desenhar nem trilha: loudnorm -14 LUFS com vídeo em cópia', () => {
      const joined = buildFinalizeArgs({ input: '/c.mp4', output: '/f.mp4', sealText: null }).join(
        ' ',
      );
      expect(joined).toContain(LOUDNORM_FILTER);
      expect(joined).toContain('-c:v copy');
      expect(joined).not.toContain('drawtext');
    });

    it('selo de TEXTO (compat v0): drawtext escapado no terço inferior + re-encode', () => {
      const joined = buildFinalizeArgs({
        input: '/c.mp4',
        output: '/f.mp4',
        sealText: 'Oferta: R$ 9,90',
      }).join(' ');
      expect(joined).toContain("drawtext=text='Oferta\\: R$ 9,90'");
      expect(joined).toContain('y=h*0.72'); // terço inferior (plano §5.4)
      expect(joined).toContain('box=1');
      expect(joined).toContain('-c:v libx264');
      expect(joined).not.toContain('enable='); // selo único fica o vídeo inteiro
    });

    it('selo vazio/whitespace é tratado como sem selo', () => {
      const joined = buildFinalizeArgs({ input: '/c.mp4', output: '/f.mp4', sealText: '  ' }).join(
        ' ',
      );
      expect(joined).not.toContain('drawtext');
    });

    it('selos por cena vencem o sealText legado', () => {
      const joined = buildFinalizeArgs({
        input: '/c.mp4',
        output: '/f.mp4',
        sealText: 'selo velho',
        sealCues: [{ text: 'CAFÉ — R$ 12,90', startS: 3, endS: 6 }],
      }).join(' ');
      expect(joined).toContain("text='CAFÉ — R$ 12,90'");
      expect(joined).not.toContain('selo velho');
    });

    it('legendas viram drawtext com janela, na margem segura inferior', () => {
      const joined = buildFinalizeArgs({
        input: '/c.mp4',
        output: '/f.mp4',
        captionCues: [
          { text: 'Bem-vindo às ofertas', startS: 0.2, endS: 1.9 },
          { text: 'da semana!', startS: 1.9, endS: 3 },
        ],
      }).join(' ');
      expect(joined).toContain("enable='between(t,0.20,1.90)'");
      expect(joined).toContain("enable='between(t,1.90,3.00)'");
      expect(joined).toContain('y=h-154-text_h'); // 12% de 1280 (margem segura 9:16)
      expect(joined).toContain('boxcolor=black@0.6');
    });

    it('trilha entra por filter_complex com DUCKING sob a fala e loudnorm no master', () => {
      const args = buildFinalizeArgs({
        input: '/c.mp4',
        output: '/f.mp4',
        musicPath: '/music.mp3',
        sealCues: [{ text: 'CAFÉ — R$ 12,90', startS: 1, endS: 4 }],
      });
      const joined = args.join(' ');
      expect(joined).toContain('-i /music.mp3');
      const complex = args[args.indexOf('-filter_complex') + 1];
      // a FALA é o sidechain que comprime a MÚSICA
      expect(complex).toContain(`[music][sc]${MUSIC_DUCKING_FILTER}[ducked]`);
      expect(complex).toContain('[voice][ducked]amix=inputs=2:duration=first');
      expect(complex).toContain(LOUDNORM_FILTER);
      expect(complex).toContain('drawtext'); // selo desenhado na cadeia [0:v]
      expect(joined).toContain('-map [v] -map [a]');
    });

    it('trilha sem nada a desenhar mantém o vídeo passando pela cadeia (null)', () => {
      const args = buildFinalizeArgs({
        input: '/c.mp4',
        output: '/f.mp4',
        musicPath: '/music.mp3',
      });
      const complex = args[args.indexOf('-filter_complex') + 1];
      expect(complex).toContain('[0:v]null[v]');
    });

    it('passe final completo com selos+legendas+trilha (snapshot do contrato)', () => {
      expect(
        buildFinalizeArgs({
          input: '/c.mp4',
          output: '/f.mp4',
          ...assemblyDimensions('9:16'),
          sealCues: [{ text: 'CAFÉ — R$ 12,90', startS: 3, endS: 6 }],
          captionCues: [{ text: 'Bem-vindo às ofertas', startS: 0.2, endS: 1.9 }],
          musicPath: '/music.mp3',
        }),
      ).toMatchSnapshot();
    });
  });

  it('buildPosterArgs extrai 1 frame em qualidade alta', () => {
    const joined = buildPosterArgs('/f.mp4', '/poster.jpg').join(' ');
    expect(joined).toContain('-frames:v 1');
    expect(joined).toContain('-q:v 2');
  });

  it('buildMockMusicArgs gera tom contínuo baixo (trilha do provider mock)', () => {
    const joined = buildMockMusicArgs('/m.mp3', 20).join(' ');
    expect(joined).toContain('sine=frequency=220');
    expect(joined).toContain('volume=0.08');
    expect(joined).toContain('-t 20');
    expect(joined).toContain('libmp3lame');
  });
});

describe('sealStyle — auto-ajuste de fonte (regressão do 1º vídeo multi-cena)', () => {
  const { sealStyle: style, SEAL_SAFE_WIDTH_RATIO: safe } =
    jest.requireActual<typeof import('./mc-assembly-graph')>('./mc-assembly-graph');

  it('texto curto mantém o corpo base (width/16)', () => {
    expect(style(720, 'CAFÉ — R$ 9,90').fontSize).toBe(45);
  });

  it('texto LONGO encolhe para caber na margem segura — o defeito real: "ARROZ TIO JOÃO 5KG — R$ 24,90" cortava na borda', () => {
    const text = 'ARROZ TIO JOÃO 5KG — R$ 24,90';
    const s = style(720, text);
    expect(s.fontSize).toBeLessThan(45);
    // largura estimada do texto cabe na margem segura
    expect(text.length * s.fontSize * 0.55).toBeLessThanOrEqual(720 * safe);
  });

  it('nunca abaixo do piso de legibilidade (22px), mesmo com texto absurdo', () => {
    expect(style(720, 'X'.repeat(200)).fontSize).toBe(22);
  });

  it('sem texto (compat) devolve o corpo base', () => {
    expect(style(720).fontSize).toBe(45);
  });
});
