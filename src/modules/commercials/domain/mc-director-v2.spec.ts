import { pipelineVersionForNewProject } from '../commercials.service';
import { estimateSpeechSeconds } from '../processors/mc-tts.processor';
import {
  buildDirectorJsonSchemaV2,
  buildDirectorSystemPromptV2,
  buildMockScriptV2,
  buildProductsSnapshot,
  normalizeDirectorScenesV2,
} from './mc-director';
import { derivationState, effectiveScenePrompts, validateScriptV2 } from './mc-script-v2';
import { buildKeyframePromptV2 } from './mc-scene-prompts';

let seq = 0;
const ids = () => `id-${++seq}`;

describe('diretor v2 (ADR §3.1/§3.2) — schema, normalização e mock', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('system prompt v2 separa estado inicial de movimento, exige tipo e produto por índice', () => {
    const prompt = buildDirectorSystemPromptV2({
      targetDurationS: 20,
      products: [{ id: 'p1', name: 'Arroz', price: '24,90', unit: 'pct' }],
    });
    expect(prompt).toMatch(/initialFrame/);
    expect(prompt).toMatch(/action_voiceover/);
    expect(prompt).toMatch(/productIndex/);
    expect(prompt).toMatch(/\[0\] Arroz \(R\$ 24,90 \/ pct\)/);
    expect(prompt).toMatch(/NÃO deve aparecer falando/);
    const schema = buildDirectorJsonSchemaV2() as {
      schema: { properties: { scenes: { items: { required: string[] } } } };
    };
    expect(schema.schema.properties.scenes.items.required).toEqual(
      expect.arrayContaining([
        'sceneType',
        'initialFrame',
        'initialFrameEn',
        'actionPrompt',
        'actionPromptEn',
        'dialogue',
        'durationS',
        'productIndex',
      ]),
    );
  });

  it('normalizeDirectorScenesV2: identidade nova, tipo×fala corrigido, produto por índice, derivação EN com hash', () => {
    const products = buildProductsSnapshot(
      [
        { name: 'Arroz', price: '24,90' },
        { name: 'Feijão', price: '8,99' },
      ],
      ids,
    );
    const scenes = normalizeDirectorScenesV2(
      [
        {
          sceneType: 'action',
          initialFrame: 'caixa',
          initialFrameEn: 'box',
          actionPrompt: 'pega',
          actionPromptEn: 'picks',
          dialogue: 'fala aqui',
          durationS: 5,
          productIndex: 1,
        },
        {
          sceneType: 'presenter',
          initialFrame: 'frente',
          initialFrameEn: 'front',
          actionPrompt: 'acena',
          actionPromptEn: 'waves',
          dialogue: null,
          durationS: 40,
          productIndex: 7,
        },
        {
          sceneType: 'action_voiceover',
          initialFrame: '',
          initialFrameEn: '',
          actionPrompt: '',
          actionPromptEn: '',
          dialogue: 'x',
          durationS: 5,
          productIndex: null,
        },
      ],
      products,
      ids,
      'test',
    );
    expect(scenes).toHaveLength(2); // cena sem ação descartada
    // action com fala vira voiceover; presenter sem fala vira action (fala null)
    expect(scenes[0]).toMatchObject({
      idx: 0,
      sceneType: 'action_voiceover',
      productRef: products[1].id,
      dialogue: 'fala aqui',
    });
    expect(scenes[1]).toMatchObject({
      idx: 1,
      sceneType: 'action',
      dialogue: null,
      productRef: null,
      durationS: 12,
    });
    expect(derivationState(scenes[0])).toBe('ready');
    expect(effectiveScenePrompts(scenes[0])).toMatchObject({
      initialFrame: 'box',
      motion: 'picks',
      lang: 'en',
    });
    expect(scenes[0].sealCue).toEqual({ startS: 2.5, endS: 5 });
  });

  it('mock v2: presenter + action_voiceover + action, válido, com produto na cena de ação narrada', () => {
    const script = buildMockScriptV2(
      { products: [{ name: 'Arroz', price: '24,90' }], storeName: 'Loja' },
      ids,
    );
    expect(script.schemaVersion).toBe(2);
    expect(validateScriptV2(script)).toEqual([]);
    expect(script.scenes.map((s) => s.sceneType)).toEqual([
      'presenter',
      'action_voiceover',
      'action',
    ]);
    expect(script.scenes[1].productRef).toBe(script.products?.[0].id);
    expect(script.scenes.every((s) => derivationState(s) === 'ready')).toBe(true);
    expect(script.endcard?.storeName).toBe('Loja');
    const noProducts = buildMockScriptV2({ products: [] }, ids);
    expect(noProducts.scenes.every((s) => s.productRef === null)).toBe(true);
  });
});

describe('buildKeyframePromptV2 — estado inicial, área livre e identidade (ADR §3.2/§3.4)', () => {
  it('descreve só o estado inicial, reserva a área segura e não proíbe emblemas aprovados', () => {
    const prompt = buildKeyframePromptV2({
      initialFrame: 'Rice bag on the shelf, hand close',
      lang: 'en',
      canonicalDesc: {
        traits: ['round body', 'store emblem on the chest'],
        colors: ['yellow'],
        style: 'cartoon 3D',
        doNots: ['no hats'],
        accessories: ['basket'],
      },
      aspectRatio: '9:16',
      safeArea: 'left',
      environmentDescription: 'cereal aisle, white light',
    });
    expect(prompt).toMatch(/STARTING frame/);
    expect(prompt).toMatch(/Starting frame: Rice bag on the shelf/);
    expect(prompt).toMatch(/LEFT third/);
    expect(prompt).toMatch(/Setting \(shared across scenes/);
    expect(prompt).toMatch(/Emblems or marks that are part of the approved character design stay/);
    expect(prompt).toMatch(/Permanent traits: round body; store emblem on the chest/);
    expect(prompt).toMatch(/Removable props — include ONLY if/);
    expect(prompt).not.toMatch(/no logos/);
  });

  it('fallback pt é explicitado no prompt', () => {
    const prompt = buildKeyframePromptV2({
      initialFrame: 'caixa na prateleira',
      lang: 'pt',
      canonicalDesc: null,
      aspectRatio: '1:1',
    });
    expect(prompt).toMatch(/Brazilian Portuguese/);
    expect(prompt).toMatch(/LOWER third/);
  });
});

describe('ativação por configuração/coorte e duração mock do TTS', () => {
  it('pipelineVersionForNewProject: off/all/cohort', () => {
    expect(pipelineVersionForNewProject('u1', {})).toBe(1);
    expect(pipelineVersionForNewProject('u1', { MC_PIPELINE_V2: 'all' })).toBe(2);
    expect(
      pipelineVersionForNewProject('u1', {
        MC_PIPELINE_V2: 'cohort',
        MC_PIPELINE_V2_USERS: 'u2, u1',
      }),
    ).toBe(2);
    expect(
      pipelineVersionForNewProject('u3', {
        MC_PIPELINE_V2: 'cohort',
        MC_PIPELINE_V2_USERS: 'u2,u1',
      }),
    ).toBe(1);
    expect(pipelineVersionForNewProject('u1', { MC_PIPELINE_V2: 'garbage' })).toBe(1);
  });

  it('estimateSpeechSeconds acompanha o texto (15 chars/s) com faixa 1–20s', () => {
    expect(estimateSpeechSeconds('')).toBe(1);
    expect(estimateSpeechSeconds('a'.repeat(75))).toBe(5);
    expect(estimateSpeechSeconds('a'.repeat(9000))).toBe(20);
  });
});
