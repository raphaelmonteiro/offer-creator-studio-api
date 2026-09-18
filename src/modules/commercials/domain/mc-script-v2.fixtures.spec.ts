import {
  FIXTURE_ASPECTS,
  fixtureCommercialScript,
  fixtureLongNamesScript,
  fixtureNoProductsScript,
  fixturePendingDerivationScript,
  fixtureSingleSceneScript,
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
    for (const aspect of FIXTURE_ASPECTS) {
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
