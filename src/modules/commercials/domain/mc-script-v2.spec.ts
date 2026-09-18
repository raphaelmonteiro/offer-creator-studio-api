import { MC_SCRIPT_SCHEMA_V2 } from './mc-quality';
import {
  convertLegacyScript,
  defaultSealCue,
  derivationState,
  diffScriptsV2,
  dialogueMentionsPrice,
  effectiveScenePrompts,
  isCompositionOnlyChange,
  isScriptV2,
  normalizeScriptV2,
  sceneSeal,
  sceneSourceHash,
  validateScriptV2,
} from './mc-script-v2';
import { McScript, McScriptScene } from './mc-types';

let seq = 0;
const ids = () => `id-${++seq}`;

function v2Script(overrides: Partial<McScript> = {}): McScript {
  return {
    version: 3,
    schemaVersion: MC_SCRIPT_SCHEMA_V2,
    products: [
      { id: 'prod-a', name: 'Arroz 5kg', price: '24,90', unit: 'pct' },
      { id: 'prod-b', name: 'Feijão', price: '8,99', unit: 'kg' },
    ],
    environments: [{ id: 'env-1', assetId: null, description: 'corredor de cereais', version: 1 }],
    scenes: [
      {
        idx: 0,
        sceneId: 's1',
        sceneType: 'presenter',
        initialFrame: 'Mascote de frente para a câmera no corredor',
        actionPrompt: 'Acena e sorri',
        dialogue: 'Bem-vindo às ofertas!',
        durationS: 6,
        productRef: null,
        environmentId: 'env-1',
      },
      {
        idx: 1,
        sceneId: 's2',
        sceneType: 'action_voiceover',
        initialFrame: 'Caixa de arroz na prateleira, mão do mascote próxima',
        actionPrompt: 'Pega a caixa e apresenta para a câmera',
        dialogue: 'Arroz por vinte e quatro e noventa!',
        durationS: 8,
        productRef: 'prod-a',
        sealCue: { startS: 3, endS: 8 },
      },
    ],
    seal: null,
    endcard: { storeName: 'Mercado Bom' },
    ...overrides,
  };
}

describe('mc-script-v2 — identidade, derivação e validação (ADR §3.2/§3.6)', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('isScriptV2 nunca infere schema de script.version', () => {
    expect(isScriptV2({ schemaVersion: 2 })).toBe(true);
    expect(isScriptV2({ schemaVersion: undefined })).toBe(false);
    expect(isScriptV2({ version: 99 } as McScript)).toBe(false);
  });

  it('sourceHash: editar a intenção PT muda o hash; espaços não importam', () => {
    const a = sceneSourceHash({ initialFrame: 'A  B', actionPrompt: 'pega   a caixa' });
    const b = sceneSourceHash({ initialFrame: 'A B', actionPrompt: 'pega a caixa' });
    const c = sceneSourceHash({ initialFrame: 'A B', actionPrompt: 'larga a caixa' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('derivação EN só vale para a MESMA intenção — PT editado não usa EN antiga', () => {
    const scene: McScriptScene = {
      idx: 0,
      sceneId: 's',
      sceneType: 'action',
      actionPrompt: 'pega a caixa',
      dialogue: null,
      durationS: 5,
    };
    scene.derived = {
      sourceHash: sceneSourceHash(scene),
      initialFrameEn: null,
      actionPromptEn: 'picks up the box',
      lang: 'en',
      provider: 'test',
      at: 'now',
    };
    expect(derivationState(scene)).toBe('ready');
    expect(effectiveScenePrompts(scene)).toMatchObject({ motion: 'picks up the box', lang: 'en' });

    scene.actionPrompt = 'larga a caixa';
    expect(derivationState(scene)).toBe('pending');
    expect(effectiveScenePrompts(scene)).toBeNull();
  });

  it('fallback PT explícito é registrado como lang=pt e usa o texto pt', () => {
    const scene: McScriptScene = {
      idx: 0,
      sceneId: 's',
      sceneType: 'action',
      initialFrame: 'caixa na prateleira',
      actionPrompt: 'pega a caixa',
      dialogue: null,
      durationS: 5,
    };
    scene.derived = {
      sourceHash: sceneSourceHash(scene),
      initialFrameEn: null,
      actionPromptEn: null,
      lang: 'pt',
      provider: 'mock',
      at: 'now',
    };
    expect(effectiveScenePrompts(scene)).toEqual({
      initialFrame: 'caixa na prateleira',
      motion: 'pega a caixa',
      lang: 'pt',
      provider: 'mock',
    });
  });

  it('validateScriptV2: roteiro válido não tem problemas', () => {
    expect(validateScriptV2(v2Script())).toEqual([]);
  });

  it('validateScriptV2: productRef inexistente, tipo×fala inválido e ids duplicados', () => {
    const script = v2Script();
    script.scenes[1].productRef = 'prod-x';
    script.scenes[0].dialogue = null; // presenter sem fala
    script.scenes.push({ ...script.scenes[1], idx: 2, sceneId: 's2' }); // duplicado
    const codes = validateScriptV2(script).map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(['PRODUCT_REF_UNKNOWN', 'SCENE_DIALOGUE_TYPE', 'SCENE_DUPLICATE_ID']),
    );
  });

  it('validateScriptV2: productRef AUSENTE com produtos no roteiro é ambíguo (exige explícito); null é "sem oferta"', () => {
    const script = v2Script();
    delete script.scenes[1].productRef;
    expect(validateScriptV2(script).map((i) => i.code)).toContain('PRODUCT_REF_MISSING');
    script.scenes[1].productRef = null;
    expect(validateScriptV2(script)).toEqual([]);
  });

  it('validateScriptV2: action com fala é rejeitada (voiceover é o tipo certo)', () => {
    const script = v2Script();
    script.scenes[1].sceneType = 'action';
    const issue = validateScriptV2(script).find((i) => i.code === 'SCENE_DIALOGUE_TYPE');
    expect(issue?.message).toMatch(/action_voiceover/);
  });

  it('normalizeScriptV2 gera sceneId/ids de produto, reindexa e zera o selo legado', () => {
    const raw: McScript = {
      version: 1,
      scenes: [
        { idx: 5, actionPrompt: 'a', dialogue: 'oi', durationS: 5 },
        { idx: 9, actionPrompt: 'b', dialogue: null, durationS: 5, productRef: null },
      ],
      products: [{ name: 'X', price: '1,00' }],
      seal: { products: [{ name: 'X', price: '1,00' }] },
    };
    const out = normalizeScriptV2(raw, ids);
    expect(out.schemaVersion).toBe(2);
    expect(out.seal).toBeNull();
    expect(out.products?.[0].id).toBe('id-1');
    expect(out.scenes.map((s) => s.idx)).toEqual([0, 1]);
    expect(out.scenes[0].sceneId).toBe('id-2');
    expect(out.scenes[0].sceneType).toBe('presenter'); // default pela fala, só sem tipo
    expect(out.scenes[1].sceneType).toBe('action');
    // produto presente e productRef ausente: fica ausente (ambíguo) para a validação apontar
    expect('productRef' in out.scenes[0]).toBe(false);
    expect(out.scenes[1].productRef).toBeNull();
  });

  it('convertLegacyScript: cria identidades, tipos históricos, snapshot de produtos e marca associação inferida', () => {
    const legacy: McScript = {
      version: 2,
      scenes: [
        { idx: 0, actionPrompt: 'acena', actionPromptEn: 'waves', dialogue: 'Oi!', durationS: 6 },
        { idx: 1, actionPrompt: 'joinha', dialogue: null, durationS: 4 },
      ],
      seal: { products: [{ name: 'Arroz', price: '24,90' }] },
      endcard: { storeName: 'Loja' },
    };
    const { script, productRefsInferred } = convertLegacyScript(legacy, ids);
    expect(productRefsInferred).toBe(true);
    expect(script.schemaVersion).toBe(2);
    expect(script.version).toBe(3);
    expect(script.products).toHaveLength(1);
    expect(script.scenes[0]).toMatchObject({
      sceneType: 'presenter',
      productRef: script.products?.[0].id,
    });
    expect(script.scenes[1]).toMatchObject({
      sceneType: 'action',
      productRef: script.products?.[0].id,
    });
    // EN legada vira derivação válida da mesma intenção
    expect(derivationState(script.scenes[0])).toBe('ready');
    expect(effectiveScenePrompts(script.scenes[0])?.motion).toBe('waves');
    expect(derivationState(script.scenes[1])).toBe('pending');
    expect(validateScriptV2(script)).toEqual([]);
    // conversão de um v2 é no-op
    expect(convertLegacyScript(script, ids).script).toBe(script);
  });

  it('sceneSeal: produto explícito do snapshot; cena sem productRef não tem selo; cue default = 2ª metade', () => {
    const script = v2Script();
    expect(sceneSeal(script, script.scenes[0])).toBeNull();
    expect(sceneSeal(script, script.scenes[1])).toEqual({
      product: script.products?.[0],
      cue: { startS: 3, endS: 8 },
    });
    expect(defaultSealCue(7)).toEqual({ startS: 3.5, endS: 7 });
  });

  it('diffScriptsV2 segue a IDENTIDADE: reordenar mantém fala/produto por sceneId', () => {
    const before = v2Script();
    const after = v2Script();
    after.scenes = [
      { ...before.scenes[1], idx: 0 },
      { ...before.scenes[0], idx: 1 },
    ];
    const diffs = diffScriptsV2(before, after);
    expect(diffs.every((d) => !d.intentChanged && !d.dialogueChanged && d.orderChanged)).toBe(true);
    expect(isCompositionOnlyChange(before, after)).toBe(true);
  });

  it('diffScriptsV2: só selo → compositionOnly; fala mudou → não é assembly_only', () => {
    const before = v2Script();
    const sealOnly = v2Script();
    sealOnly.scenes[1].productRef = 'prod-b';
    expect(diffScriptsV2(before, sealOnly)[1]).toMatchObject({ compositionOnlyChanged: true });
    expect(isCompositionOnlyChange(before, sealOnly)).toBe(true);

    const spoken = v2Script();
    spoken.scenes[1].productRef = 'prod-b';
    spoken.scenes[1].dialogue = 'Feijão por oito e noventa e nove!';
    expect(isCompositionOnlyChange(before, spoken)).toBe(false);
    expect(diffScriptsV2(before, spoken)[1]).toMatchObject({
      dialogueChanged: true,
      compositionOnlyChanged: false,
    });
  });

  it('diffScriptsV2: cena adicionada e removida', () => {
    const before = v2Script();
    const after = v2Script();
    after.scenes = [before.scenes[0], { ...before.scenes[1], sceneId: 's9', idx: 1 }];
    const diffs = diffScriptsV2(before, after);
    expect(diffs.find((d) => d.sceneId === 's9')?.added).toBe(true);
    expect(diffs.find((d) => d.sceneId === 's2')?.removed).toBe(true);
    expect(isCompositionOnlyChange(before, after)).toBe(false);
  });

  it('dialogueMentionsPrice detecta preço por extenso e numérico', () => {
    expect(dialogueMentionsPrice('Arroz por vinte e quatro e noventa!')).toBe(true);
    expect(dialogueMentionsPrice('Leve por R$ 9,99')).toBe(true);
    expect(dialogueMentionsPrice('Bem-vindo às ofertas!')).toBe(false);
    expect(dialogueMentionsPrice(null)).toBe(false);
  });
});
