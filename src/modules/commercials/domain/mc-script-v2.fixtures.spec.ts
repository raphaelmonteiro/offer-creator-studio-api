import {
  FIXTURE_PRODUCTS,
  FIXTURE_SCENES_ASPECTS,
  fixtureCommercialScript,
  fixtureLongNamesScript,
  fixtureNoProductsScript,
  fixturePendingDerivationScript,
  fixtureSingleSceneScript,
  fixtureTalkTileScript,
} from './__fixtures__/mc-script-v2.fixtures';
import {
  buildSealCuesV2,
  formatSealText,
  sealStyle,
  assemblyDimensions,
  SEAL_SAFE_WIDTH_RATIO,
} from './mc-assembly-graph';
import { quotePhase } from './mc-pricing.config';
import {
  derivationState,
  effectiveScenePrompts,
  sceneSeal,
  validateScriptV2,
} from './mc-script-v2';
import { McSceneType } from './mc-types';

/** As fixtures de P0 precisam ser válidas e cobrir os casos que o plano pede. */
describe('fixtures v2 (P0) — roteiros utilizáveis', () => {
  it('comercial completo: 3 tipos + CTA sem oferta, válido, derivações prontas', () => {
    const script = fixtureCommercialScript();
    expect(validateScriptV2(script)).toEqual([]);
    expect(script.scenes.map((s) => s.sceneType)).toEqual([
      'presenter',
      'action_voiceover',
      'action',
      'presenter',
    ]);
    expect(script.scenes.every((s) => derivationState(s) === 'ready')).toBe(true);
    expect(effectiveScenePrompts(script.scenes[1])?.motion).toMatch(/picks the bag/);
    expect(sceneSeal(script, script.scenes[3])).toBeNull(); // CTA sem selo
    expect(sceneSeal(script, script.scenes[1])?.product.id).toBe('prod-arroz');
  });

  it.each(['presenter', 'action', 'action_voiceover'] as McSceneType[])(
    'cena independente %s é válida',
    (type) => {
      const script = fixtureSingleSceneScript(type);
      expect(script.scenes).toHaveLength(1);
      expect(script.scenes[0].sceneType).toBe(type);
      expect(validateScriptV2(script)).toEqual([]);
    },
  );

  it('derivação pendente é detectada (intenção editada após a tradução)', () => {
    const script = fixturePendingDerivationScript();
    expect(derivationState(script.scenes[1])).toBe('pending');
    expect(effectiveScenePrompts(script.scenes[1])).toBeNull();
    expect(derivationState(script.scenes[0])).toBe('ready');
  });

  it('nomes/preços longos: o selo encolhe a fonte até o piso legível em todos os formatos', () => {
    const script = fixtureLongNamesScript();
    expect(validateScriptV2(script)).toEqual([]);
    const text = formatSealText(script.products![0]);
    expect(text).toBe(
      'CHOCOLATE AO LEITE COM AVELÃS CROCANTES EDIÇÃO COMEMORATIVA 250G — R$ 1.299,90',
    );
    // selo da montagem 720p (F3): só os aspectos do formato `scenes`
    for (const aspect of FIXTURE_SCENES_ASPECTS) {
      const { width } = assemblyDimensions(aspect);
      const style = sealStyle(width, text);
      expect(style.fontSize).toBeGreaterThanOrEqual(22);
      // largura estimada cabe na margem segura OU está no piso (texto longo toca as bordas, nunca some)
      const estimated = text.length * 0.55 * style.fontSize;
      expect(estimated <= width * SEAL_SAFE_WIDTH_RATIO + 1 || style.fontSize === 22).toBe(true);
    }
    const cues = buildSealCuesV2(
      [
        {
          sceneId: 'fx-scene-voiceover',
          idx: 0,
          startS: 0,
          endS: 5,
          finalAssetId: 'f',
          captionsMissing: false,
        },
      ],
      [
        {
          sceneId: 'fx-scene-voiceover',
          product: script.products![0],
          cue: script.scenes[1].sealCue!,
        },
      ],
    );
    expect(cues[0].text).toBe(text);
  });

  it('sem produtos: nenhuma cena tem selo e a validação passa', () => {
    const script = fixtureNoProductsScript();
    expect(validateScriptV2(script)).toEqual([]);
    expect(script.scenes.every((s) => sceneSeal(script, s) === null)).toBe(true);
  });

  it('cotação do comercial completo: preparação e produção pelo grafo (sem Avatar no voiceover)', () => {
    const script = fixtureCommercialScript();
    const inputs = script.scenes.map((s) => ({
      sceneId: s.sceneId as string,
      sceneType: s.sceneType as McSceneType,
      cached: [],
    }));
    expect(quotePhase('preparation', 1, inputs).totalCredits).toBe(4 * 1 + 3 * 4); // 4 keyframes + 3 TTS
    expect(quotePhase('production', 1, inputs).totalCredits).toBe(56 + 89 + 89 + 56); // presenter, voiceover(video), action, presenter
  });
});

describe('fixture talk_tile (change video-formatos-personagem, D6/D7)', () => {
  it('três falas talk_tile válidas SEM initialFrame/cenário/referências; gesto opcional', () => {
    const script = fixtureTalkTileScript();
    expect(validateScriptV2(script)).toEqual([]);
    expect(script.scenes.map((s) => s.sceneType)).toEqual(['talk_tile', 'talk_tile', 'talk_tile']);
    expect(script.scenes.every((s) => s.initialFrame === undefined)).toBe(true);
    expect(script.scenes.every((s) => s.environmentId === null)).toBe(true);
    expect(script.scenes.every((s) => !!s.dialogue)).toBe(true);
    // gesto só na primeira (com derivação EN); as outras sem ação — aceitas pela validação
    expect(script.scenes[0].actionPrompt).toBe('Acena no início.');
    expect(effectiveScenePrompts(script.scenes[0])?.motion).toBe('Waves at the start.');
    expect(script.scenes[1].actionPrompt).toBe('');
    expect(script.scenes.map((s) => s.durationS)).toEqual([6, 7, 5]);
  });

  it('cor da janela e produto citado entram quando pedidos', () => {
    const script = fixtureTalkTileScript({
      products: FIXTURE_PRODUCTS,
      backgroundColor: '#FF8800',
    });
    expect(validateScriptV2(script)).toEqual([]);
    expect(script.talkBackgroundColor).toBe('#FF8800');
    expect(script.scenes[1].productRef).toBe('prod-arroz');
    expect(fixtureTalkTileScript().talkBackgroundColor).toBeUndefined();
  });

  it('cotação: preparação só TTS (3 × 4); produção só talk (3 × 56), nunca keyframe', () => {
    const script = fixtureTalkTileScript();
    const inputs = script.scenes.map((s) => ({
      sceneId: s.sceneId as string,
      sceneType: s.sceneType as McSceneType,
      cached: [],
    }));
    const preparation = quotePhase('preparation', 1, inputs);
    expect(preparation.totalCredits).toBe(3 * 4);
    expect(preparation.items.map((i) => i.stepType)).toEqual(['tts', 'tts', 'tts']);
    const production = quotePhase('production', 1, inputs);
    expect(production.items.filter((i) => i.sceneId).map((i) => i.stepType)).toEqual([
      'talk',
      'talk',
      'talk',
    ]);
    expect(production.totalCredits).toBe(3 * 56);
  });

  it('cena talk_tile com um tipo de ação vazio e sem fala é recusada (uma fala, um clipe)', () => {
    const script = fixtureTalkTileScript();
    script.scenes[2] = { ...script.scenes[2], dialogue: null };
    expect(validateScriptV2(script).map((i) => i.code)).toContain('SCENE_DIALOGUE_TYPE');
  });
});
