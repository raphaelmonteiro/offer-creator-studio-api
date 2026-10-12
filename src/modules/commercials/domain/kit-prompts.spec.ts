import {
  buildKitReferencePrompt,
  isKitReferenceSlot,
  KIT_FRONT_SLOT,
  KIT_REFERENCE_BACKGROUND_DEFAULT,
  KIT_REFERENCE_SLOT_COUNT,
  KIT_REFERENCE_SLOTS,
  KIT_SLOT_WITH_PROP,
  KitCanonicalDesc,
  KitReferenceSlot,
  hasPtMirror,
  mergeTranslatedSheet,
  parseCanonicalDesc,
} from './kit-prompts';
import { MC_KIT_SOURCES, MC_KIT_STYLES, STYLE_BLOCKS } from './mc-kit-identity';

describe('kit-prompts — prompts fixos das referências do kit (plano §4)', () => {
  it('tem exatamente 4 slots na ordem contratada com a UI de review', () => {
    expect(KIT_REFERENCE_SLOT_COUNT).toBe(4);
    expect(KIT_REFERENCE_SLOTS).toEqual([
      'three_quarter_left',
      'profile',
      'talking',
      'holding_product',
    ]);
  });

  it.each([
    [0, /three-quarter view facing left/],
    [1, /profile \(side\) view/],
    [2, /mouth open .*hands gesturing/],
    [3, /generic unlabeled product/],
  ])('slot %i ancora a pose correta', (slot, pattern) => {
    expect(buildKitReferencePrompt(slot as KitReferenceSlot)).toMatch(pattern);
  });

  it('todo slot proíbe texto/logo/marca d’água (regra de ouro §5.4: crítico não passa pela IA)', () => {
    for (let slot = 0; slot < KIT_REFERENCE_SLOT_COUNT; slot++) {
      expect(buildKitReferencePrompt(slot as KitReferenceSlot)).toMatch(
        /no text, no logo, no watermark/,
      );
    }
  });

  it('é determinístico: mesmo slot + mesma descrição ⇒ mesmo prompt (contrato do input_hash §6.3)', () => {
    const desc: KitCanonicalDesc = {
      traits: ['abelha simpática'],
      colors: ['#FFD700'],
      style: 'cartoon 2D',
      doNots: ['nunca mudar as listras'],
    };
    expect(buildKitReferencePrompt(2, desc)).toBe(buildKitReferencePrompt(2, desc));
  });

  it('embute a descrição canônica quando fornecida', () => {
    const desc: KitCanonicalDesc = {
      traits: ['abelha amarela', 'olhos grandes'],
      colors: ['#FFD700', 'preto'],
      style: 'cartoon 2D flat',
      doNots: ['nunca remover as antenas'],
    };
    const prompt = buildKitReferencePrompt(0, desc);
    expect(prompt).toContain('Character sheet');
    expect(prompt).toContain('abelha amarela; olhos grandes');
    expect(prompt).toContain('#FFD700, preto');
    expect(prompt).toContain('cartoon 2D flat');
    expect(prompt).toContain('nunca remover as antenas');
  });

  it('sem descrição canônica devolve só o prompt base', () => {
    expect(buildKitReferencePrompt(1)).not.toContain('Character sheet');
    expect(buildKitReferencePrompt(1, null)).not.toContain('Character sheet');
  });

  it('rejeita slot fora de 0..3', () => {
    expect(() => buildKitReferencePrompt(4 as KitReferenceSlot)).toThrow(/inválido/);
    expect(() => buildKitReferencePrompt(-1 as KitReferenceSlot)).toThrow(/inválido/);
  });

  it('isKitReferenceSlot valida o range', () => {
    expect(isKitReferenceSlot(0)).toBe(true);
    expect(isKitReferenceSlot(3)).toBe(true);
    expect(isKitReferenceSlot(4)).toBe(false);
    expect(isKitReferenceSlot('2')).toBe(false);
    expect(isKitReferenceSlot(null)).toBe(false);
  });

  // v1.15 — a ficha da capivara veio com "carrega uma cesta de frutas" como
  // TRAÇO e "nunca remover a cesta" em doNots: o prop da arte original virava
  // identidade e reaparecia em toda cena. Acessório agora é campo separado.
  describe('acessórios (props removíveis) e ajustes do usuário', () => {
    const desc: KitCanonicalDesc = {
      traits: ['capivara antropomórfica', 'avental vermelho'],
      colors: ['#FF4500'],
      style: '3D cartoon',
      doNots: ['nunca mudar a espécie'],
      accessories: ['green shopping basket', 'cardboard box'],
    };

    it.each([0, 1, 2])('slot %i pede mãos vazias e nomeia os acessórios proibidos', (slot) => {
      const prompt = buildKitReferencePrompt(slot as KitReferenceSlot, desc);
      expect(prompt).toContain('must NOT hold or carry any object');
      expect(prompt).toContain('green shopping basket, cardboard box');
    });

    it(`slot ${KIT_SLOT_WITH_PROP} mantém a caixa genérica e barra os outros props`, () => {
      const prompt = buildKitReferencePrompt(KIT_SLOT_WITH_PROP, desc);
      expect(prompt).toContain('generic unlabeled product');
      expect(prompt).not.toContain('must NOT hold or carry any object');
      expect(prompt).toContain('do NOT add: green shopping basket, cardboard box');
    });

    it('sem acessórios listados, a regra de mãos vazias continua valendo', () => {
      const prompt = buildKitReferencePrompt(0, { ...desc, accessories: [] });
      expect(prompt).toContain('both hands are empty');
      expect(prompt).not.toContain('Specifically, do NOT include');
    });

    it('ajuste do usuário entra por último e com prioridade declarada', () => {
      const prompt = buildKitReferencePrompt(0, {
        ...desc,
        adjustments: 'Remove the basket from his hands',
      });
      expect(prompt).toContain('User adjustments (highest priority, follow strictly)');
      expect(prompt.trimEnd().endsWith('Remove the basket from his hands')).toBe(true);
    });
  });

  /**
   * Change video-formatos-personagem (D1/D5): estilo como bloco fixo (fim do
   * hack de `adjustments`), origem `logo` sem "no logo", cor de fundo do slot
   * frontal como parâmetro. Os snapshots são o contrato de reprodutibilidade:
   * mudar um prompt = mudar o snapshot de propósito (e o hash do kit).
   */
  describe('estilo fixo, origem e cor de fundo (D1/D5)', () => {
    const desc: KitCanonicalDesc = {
      traits: ['friendly capybara', 'red apron'],
      colors: ['#FF4500'],
      style: 'hand-drawn 2D sketch',
      doNots: ['never change the species'],
      accessories: ['green shopping basket'],
      adjustments: 'Make the eyes a bit bigger',
    };
    const allSlots = (options: Parameters<typeof buildKitReferencePrompt>[2]) =>
      KIT_REFERENCE_SLOTS.map((_, slot) =>
        buildKitReferencePrompt(slot as KitReferenceSlot, desc, options),
      );
    const matrix = MC_KIT_STYLES.flatMap((style) =>
      MC_KIT_SOURCES.map((source) => [style, source] as const),
    );

    it.each(matrix)('snapshot dos 4 slots: estilo %s × origem %s', (style, source) => {
      expect(allSlots({ style, source })).toMatchSnapshot();
    });

    it('bloco de estilo entra em todo slot e o estilo livre da ficha sai (não disputa com o fixo)', () => {
      for (const style of MC_KIT_STYLES) {
        for (const prompt of allSlots({ style, source: 'mascot' })) {
          expect(prompt).toContain(STYLE_BLOCKS[style]);
          expect(prompt).toContain('Rendering style (FIXED for this character');
          expect(prompt).not.toContain('- Style: hand-drawn 2D sketch');
        }
      }
    });

    it('com estilo fixo, os ajustes do usuário deixam de ser "highest priority" (não mudam o estilo)', () => {
      const prompt = buildKitReferencePrompt(0, desc, { style: '3d_render' });
      expect(prompt).not.toContain('highest priority');
      expect(prompt).toContain('never override the fixed rendering style above');
      expect(prompt.trimEnd().endsWith('Make the eyes a bit bigger')).toBe(true);
    });

    it('sem estilo (kit anterior) o prompt é o legado: sem bloco, com "- Style:" da ficha e ajustes prioritários', () => {
      const legacy = buildKitReferencePrompt(0, desc);
      expect(legacy).toBe(buildKitReferencePrompt(0, desc, {}));
      expect(legacy).toBe(buildKitReferencePrompt(0, desc, { style: null, source: 'mascot' }));
      expect(legacy).not.toContain('Rendering style');
      expect(legacy).toContain('- Style: hand-drawn 2D sketch');
      expect(legacy).toContain('User adjustments (highest priority, follow strictly)');
      expect(buildKitReferencePrompt(1)).toBe(
        'Turnaround reference: the exact same mascot character from the reference image, ' +
          'full profile (side) view, full body, neutral standing pose. ' +
          'Plain solid light gray background, even studio lighting, no text, no logo, no watermark.',
      );
    });

    it('origem logo: cai o "no logo" (as marcas do logo são a identidade), fica proibido texto adicionado', () => {
      for (const prompt of allSlots({ source: 'logo', style: 'cartoon_2d' })) {
        expect(prompt).not.toMatch(/no logo/);
        expect(prompt).toContain('no added text, no watermark');
        expect(prompt).toContain(
          'marks that belong to the logo itself stay exactly as in the reference',
        );
      }
      for (const prompt of allSlots({ source: 'mascot', style: 'cartoon_2d' })) {
        expect(prompt).toMatch(/no text, no logo, no watermark/);
      }
    });

    it('cor de fundo só no slot frontal: hex vira cor exata; os demais seguem no cinza claro', () => {
      expect(KIT_FRONT_SLOT).toBe(2);
      expect(KIT_REFERENCE_BACKGROUND_DEFAULT).toBe('light gray');
      const prompts = allSlots({ backgroundColor: '#1e90ff' });
      expect(prompts[KIT_FRONT_SLOT]).toContain(
        'Plain solid background filled with the exact color #1E90FF (uniform, no gradient, no texture)',
      );
      expect(prompts[KIT_FRONT_SLOT]).not.toContain('light gray');
      for (const slot of [0, 1, 3]) {
        expect(prompts[slot]).toContain('Plain solid light gray background');
        expect(prompts[slot]).not.toContain('#1E90FF');
      }
      // nome de cor segue como texto; vazio/nulo cai no padrão
      expect(
        buildKitReferencePrompt(KIT_FRONT_SLOT, null, { backgroundColor: 'warm beige' }),
      ).toContain('Plain solid warm beige background');
      expect(buildKitReferencePrompt(KIT_FRONT_SLOT, null, { backgroundColor: null })).toBe(
        buildKitReferencePrompt(KIT_FRONT_SLOT),
      );
    });
  });

  describe('parseCanonicalDesc — parser único (era duplicado em 2 processors)', () => {
    it('lê a ficha v2 completa, com acessórios e espelho pt-BR', () => {
      const desc = parseCanonicalDesc(
        JSON.stringify({
          traits: ['capybara character'],
          colors: ['#FF4500'],
          style: '3D cartoon',
          doNots: ['never change the species'],
          accessories: ['shopping basket'],
          pt: {
            traits: ['personagem capivara'],
            doNots: ['nunca mudar a espécie'],
            accessories: ['cesta de compras'],
            style: 'cartoon 3D',
          },
        }),
      );
      expect(desc?.accessories).toEqual(['shopping basket']);
      expect(desc?.pt?.traits).toEqual(['personagem capivara']);
      expect(desc?.pt?.style).toBe('cartoon 3D');
    });

    it('ficha v1 (sem acessórios/pt) continua válida — kits antigos não quebram', () => {
      const desc = parseCanonicalDesc(
        JSON.stringify({ traits: ['abelha'], colors: [], style: 'flat', doNots: [] }),
      );
      expect(desc?.traits).toEqual(['abelha']);
      expect(desc?.accessories).toEqual([]);
      expect(desc?.pt).toBeUndefined();
    });

    it('espelho pt de tamanho diferente é descartado (pareamento por índice na UI)', () => {
      const desc = parseCanonicalDesc(
        JSON.stringify({
          traits: ['a', 'b'],
          colors: [],
          style: '',
          doNots: [],
          pt: { traits: ['só um'] },
        }),
      );
      expect(desc?.pt?.traits).toBeUndefined();
    });

    it('JSON inválido, vazio ou sem traits → null (cai no texto cru na UI)', () => {
      expect(parseCanonicalDesc('não é json')).toBeNull();
      expect(parseCanonicalDesc(null)).toBeNull();
      expect(parseCanonicalDesc('[]')).toBeNull();
      expect(parseCanonicalDesc('{"style":"cartoon"}')).toBeNull();
    });

    it('kit antigo (só inglês) é detectado como não traduzido', () => {
      const legacy = parseCanonicalDesc(
        JSON.stringify({ traits: ['a', 'b'], colors: [], style: 'flat', doNots: ['c'] }),
      )!;
      expect(hasPtMirror(legacy)).toBe(false);
      const traduzido = mergeTranslatedSheet(legacy, {
        traits: ['x', 'y'],
        doNots: ['z'],
        accessories: [],
        style: 'chapado',
      });
      expect(hasPtMirror(traduzido)).toBe(true);
      expect(traduzido.pt).toEqual({ traits: ['x', 'y'], doNots: ['z'], style: 'chapado' });
      // tradução não toca no inglês, que é o que os motores leem
      expect(traduzido.traits).toEqual(['a', 'b']);
    });

    it('tradução com número de itens diferente é descartada (pareamento por índice)', () => {
      const desc = parseCanonicalDesc(
        JSON.stringify({ traits: ['a', 'b'], colors: [], style: '', doNots: [] }),
      )!;
      expect(mergeTranslatedSheet(desc, { traits: ['só um'] }).pt?.traits).toBeUndefined();
    });

    it('ficha sem listas preenchidas conta como traduzida (nada a traduzir)', () => {
      const vazio = parseCanonicalDesc(
        JSON.stringify({ traits: [], colors: ['#fff'], style: 'flat', doNots: [] }),
      );
      expect(vazio && hasPtMirror(vazio)).toBe(true);
    });

    it('descarta itens vazios e limita o tamanho de cada linha', () => {
      const desc = parseCanonicalDesc(
        JSON.stringify({
          traits: ['ok', '   ', 42, 'x'.repeat(400)],
          colors: [],
          style: '',
          doNots: [],
        }),
      );
      // '   ' e o número 42 saem; sobra 'ok' e a linha longa, cortada em 240.
      expect(desc?.traits).toHaveLength(2);
      expect(desc?.traits[1]).toHaveLength(240);
    });
  });
});
