import { selectReferences } from './mc-references';
import { buildKeyframePromptV2 } from './mc-scene-prompts';
import { computeKeyframeHashV2 } from './mc-step-hashes';

/** Foto real do produto como referência do keyframe (ADR §3.4/§3.6 — embalagem fiel ao SKU). */
describe('referência de produto real (foto do catálogo/galeria)', () => {
  const kit = [
    { assetId: 'k0', slot: 0 },
    { assetId: 'k1', slot: 1 },
    { assetId: 'k2', slot: 2 },
    { assetId: 'k3', slot: 3 },
  ];

  it('a foto do produto entra logo após a identidade, antes da pose genérica de segurar, dentro do limite', () => {
    const refs = selectReferences({
      sceneType: 'action_voiceover',
      hasProduct: true,
      productImageUrl: '/uploads/products/arroz-tio-joao-5kg.png',
      motionPrompt: 'picks the bag and presents it',
      kitReferences: kit,
      maxReferences: 3,
    });
    expect(refs.map((r) => r.role)).toEqual(['identity', 'product', 'interaction']);
    expect(refs[1]).toMatchObject({
      assetId: 'product:/uploads/products/arroz-tio-joao-5kg.png',
      fileUrl: '/uploads/products/arroz-tio-joao-5kg.png',
      slot: null,
    });
    // limite de 2: identidade + produto (a pose genérica cede a vaga à embalagem real)
    const two = selectReferences({
      sceneType: 'action',
      hasProduct: true,
      productImageUrl: '/uploads/p.png',
      motionPrompt: 'holds',
      kitReferences: kit,
      maxReferences: 2,
    });
    expect(two.map((r) => r.role)).toEqual(['identity', 'product']);
  });

  it('cena sem produto ou produto sem foto: nenhuma referência de produto', () => {
    const refs = selectReferences({
      sceneType: 'presenter',
      hasProduct: true,
      productImageUrl: null,
      motionPrompt: 'waves',
      kitReferences: kit,
      maxReferences: 3,
    });
    expect(refs.some((r) => r.role === 'product')).toBe(false);
  });

  it('a foto do produto entra no hash do keyframe: trocar a foto invalida a prévia', () => {
    const base = {
      kitId: 'k',
      kitVersion: 1,
      aspectRatio: '9:16',
      initialFramePrompt: 'bag on shelf',
      promptLang: 'en' as const,
      environment: null,
      attempt: 1,
    };
    const withA = computeKeyframeHashV2({
      ...base,
      references: [{ assetId: 'product:/uploads/a.png', role: 'product', slot: null, reason: '' }],
    });
    const withB = computeKeyframeHashV2({
      ...base,
      references: [{ assetId: 'product:/uploads/b.png', role: 'product', slot: null, reason: '' }],
    });
    expect(withA).not.toBe(withB);
  });

  it('prompt do keyframe pede a embalagem EXATA e não proíbe o texto impresso no pacote', () => {
    const prompt = buildKeyframePromptV2({
      initialFrame: 'rice bag on the shelf',
      lang: 'en',
      canonicalDesc: null,
      aspectRatio: '9:16',
      productName: 'Arroz Tio João Integral 5kg',
    });
    expect(prompt).toMatch(/REAL package of "Arroz Tio João Integral 5kg"/);
    expect(prompt).toMatch(/EXACTLY this package/);
    expect(prompt).toMatch(/No ADDED promotional text/);
    expect(prompt).toMatch(/text printed on the real product package stays/);
    const without = buildKeyframePromptV2({
      initialFrame: 'x',
      lang: 'en',
      canonicalDesc: null,
      aspectRatio: '9:16',
    });
    expect(without).not.toMatch(/Product reference/);
  });
});
