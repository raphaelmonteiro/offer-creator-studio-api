import { computeContentHash } from './input-hash';
import {
  buildRenderedTimeline,
  buildSealCues,
  buildSealCuesV2,
  SceneWindowV2,
} from './mc-assembly-graph';
import { quotePhase } from './mc-pricing.config';
import {
  approvalAuthorizes,
  findPhaseBudget,
  isPipelineV2,
  MC_EMPTY_QUALITY,
  phaseLedgerKey,
  resolveQuality,
  upsertPhaseBudget,
} from './mc-quality';
import { keyframeReferenceLimit, selectReferences } from './mc-references';
import {
  buildSceneComposeArgs,
  composeDurationIssue,
  composedOutputIssue,
  voiceoverPlanExcessMs,
} from './mc-scene-compose-graph';
import {
  computeAssemblyHashV2,
  computeKeyframeHashV2,
  computeLipsyncHashV2,
  computeSceneComposeHash,
  computeSceneStepHashes,
  computeTtsHashV2,
  computeVideoHashV2,
} from './mc-step-hashes';
import { McStepType } from './mc-types';

describe('mc-quality — estado, orçamento e aprovação (ADR §4)', () => {
  it('resolveQuality tolera jsonb parcial/nulo', () => {
    expect(resolveQuality(null)).toEqual(MC_EMPTY_QUALITY);
    expect(resolveQuality({ resumePhase: 'production' })).toMatchObject({
      resumePhase: 'production',
      budgets: [],
      captionsMissingAccepted: false,
    });
  });

  it('isPipelineV2 e chave de ledger por fase', () => {
    expect(isPipelineV2({ pipelineVersion: 2 })).toBe(true);
    expect(isPipelineV2({ pipelineVersion: 1 })).toBe(false);
    expect(isPipelineV2({})).toBe(false);
    expect(phaseLedgerKey('p1', 'preparation', 3)).toBe('p1:preparation:r3');
  });

  it('upsertPhaseBudget substitui a mesma fase/revisão sem duplicar', () => {
    const base = resolveQuality(null);
    const b1 = {
      phase: 'preparation' as const,
      revision: 1,
      quotedCredits: 5,
      reservedCredits: 5,
      consumedCredits: 0,
      refundedCredits: 0,
      ledgerKey: 'k',
      settledAt: null,
      items: [],
    };
    const q1 = upsertPhaseBudget(base, b1);
    const q2 = upsertPhaseBudget(q1, { ...b1, consumedCredits: 5 });
    expect(q2.budgets).toHaveLength(1);
    expect(findPhaseBudget(q2, 'preparation', 1)?.consumedCredits).toBe(5);
    expect(findPhaseBudget(q2, 'production', 1)).toBeNull();
  });

  it('approvalAuthorizes exige revisão E escopo iguais', () => {
    const quality = resolveQuality({
      approval: {
        scope: 'production',
        revision: 2,
        manifestHash: 'h',
        approvedAt: 'now',
        userId: 'u',
        budgetCredits: 0,
      },
    });
    expect(approvalAuthorizes(quality, 2, 'production')).toBe(true);
    expect(approvalAuthorizes(quality, 1, 'production')).toBe(false);
    expect(approvalAuthorizes(quality, 2, 'assembly_only')).toBe(false);
    expect(approvalAuthorizes(null, 2, 'production')).toBe(false);
    // revisão assembly_only aprovada + produção aprovada antes ⇒ produção (refazer vídeo) autorizada
    const assemblyOnly = resolveQuality({
      approval: {
        scope: 'assembly_only',
        revision: 3,
        manifestHash: 'h',
        approvedAt: 'now',
        userId: 'u',
        budgetCredits: 0,
      },
      productionApproval: {
        scope: 'production',
        revision: 2,
        manifestHash: 'h',
        approvedAt: 'now',
        userId: 'u',
        budgetCredits: 0,
      },
    });
    expect(approvalAuthorizes(assemblyOnly, 3, 'production')).toBe(true);
    expect(approvalAuthorizes(assemblyOnly, 3, 'assembly_only')).toBe(true);
    expect(approvalAuthorizes({ ...assemblyOnly, productionApproval: null }, 3, 'production')).toBe(
      false,
    );
    expect(approvalAuthorizes(assemblyOnly, 2, 'production')).toBe(false);
  });
});

describe('quotePhase — preço fechado pelo grafo (ADR §4.3)', () => {
  it('cota só os steps da fase e do tipo; cache entra com 0; assembly na produção', () => {
    const prep = quotePhase('preparation', 1, [
      { sceneId: 'a', sceneType: 'presenter', cached: [McStepType.TTS] },
      { sceneId: 'b', sceneType: 'action', cached: [] },
      { sceneId: 'c', sceneType: 'action_voiceover', cached: [McStepType.KEYFRAME] },
    ]);
    expect(prep.totalCredits).toBe(1 + 0 + 1 + 0 + 4); // kf(a) + tts(a cached) + kf(b) + kf(c cached) + tts(c)
    expect(
      prep.items.find((i) => i.sceneId === 'a' && i.stepType === McStepType.TTS),
    ).toMatchObject({ cached: true, credits: 0 });
    expect(
      prep.items.some((i) => i.stepType === McStepType.VIDEO || i.stepType === McStepType.LIPSYNC),
    ).toBe(false);

    const prod = quotePhase('production', 1, [
      { sceneId: 'a', sceneType: 'presenter', cached: [] },
      { sceneId: 'b', sceneType: 'action', cached: [] },
      { sceneId: 'c', sceneType: 'action_voiceover', cached: [] },
    ]);
    // presenter: lipsync 56; action: video 89; voiceover: video 89 + compose 0; assembly 0
    expect(prod.totalCredits).toBe(56 + 89 + 89);
    expect(prod.items.filter((i) => i.sceneId === 'a').map((i) => i.stepType)).toEqual([
      McStepType.LIPSYNC,
    ]);
    expect(prod.items.filter((i) => i.sceneId === 'c').map((i) => i.stepType)).toEqual([
      McStepType.VIDEO,
      McStepType.SCENE_COMPOSE,
    ]);
    expect(prod.items.some((i) => i.stepType === McStepType.ASSEMBLY)).toBe(true);
    // voiceover NÃO inclui Avatar na estimativa
    expect(
      prod.items.filter((i) => i.sceneId === 'c').some((i) => i.stepType === McStepType.LIPSYNC),
    ).toBe(false);
  });

  it('fase assembly cota só a montagem', () => {
    const q = quotePhase('assembly', 2, [{ sceneId: 'a', sceneType: 'presenter', cached: [] }]);
    expect(q.items.map((i) => i.stepType)).toEqual([McStepType.ASSEMBLY]);
    expect(q.totalCredits).toBe(0);
  });
});

describe('hashes v2 — requisição efetiva (ADR §4.2)', () => {
  const kf = {
    kitId: 'k',
    kitVersion: 1,
    aspectRatio: '9:16',
    initialFramePrompt: 'box on shelf',
    promptLang: 'en' as const,
    references: [{ assetId: 'r0', role: 'identity' as const, slot: 0, reason: '' }],
    environment: null,
    attempt: 1,
  };

  it('keyframe: prompt efetivo, idioma, referências, cenário, modelo e tentativa entram', () => {
    const base = computeKeyframeHashV2(kf);
    expect(computeKeyframeHashV2({ ...kf, promptLang: 'pt' })).not.toBe(base);
    expect(
      computeKeyframeHashV2({ ...kf, references: [{ ...kf.references[0], assetId: 'r1' }] }),
    ).not.toBe(base);
    expect(
      computeKeyframeHashV2({ ...kf, environment: { id: 'e', version: 2, assetId: null } }),
    ).not.toBe(base);
    expect(computeKeyframeHashV2({ ...kf, attempt: 2 })).not.toBe(base);
    expect(computeKeyframeHashV2({ ...kf, model: 'other' })).not.toBe(base);
    // o motivo da seleção NÃO entra (auditoria, não input)
    expect(
      computeKeyframeHashV2({ ...kf, references: [{ ...kf.references[0], reason: 'x' }] }),
    ).toBe(base);
  });

  it('video: keyframe SELECIONADO + movimento efetivo + duração do provider + tentativa', () => {
    const v = {
      keyframeAssetId: 'a1',
      motionPrompt: 'picks the box',
      promptLang: 'en' as const,
      providerDuration: '5',
      attempt: 1,
    };
    const base = computeVideoHashV2(v);
    expect(computeVideoHashV2({ ...v, keyframeAssetId: 'a2' })).not.toBe(base);
    expect(computeVideoHashV2({ ...v, providerDuration: '10' })).not.toBe(base);
    expect(computeVideoHashV2({ ...v, motionPrompt: 'drops the box' })).not.toBe(base);
    expect(computeVideoHashV2({ ...v, attempt: 2 })).not.toBe(base);
  });

  it('lipsync/tts/scene_compose/assembly v2 são sensíveis aos assets selecionados', () => {
    expect(computeLipsyncHashV2({ keyframeAssetId: 'a', audioAssetId: 'b', attempt: 1 })).not.toBe(
      computeLipsyncHashV2({ keyframeAssetId: 'a', audioAssetId: 'c', attempt: 1 }),
    );
    expect(computeTtsHashV2({ dialogue: 'oi', voiceId: 'v', attempt: 1 })).not.toBe(
      computeTtsHashV2({ dialogue: 'oi', voiceId: 'v', attempt: 2 }),
    );
    expect(
      computeSceneComposeHash({ videoAssetId: 'v', audioAssetId: 'a', plannedDurationS: 8 }),
    ).not.toBe(
      computeSceneComposeHash({ videoAssetId: 'v', audioAssetId: 'a2', plannedDurationS: 8 }),
    );
    const asm = {
      scenes: [{ sceneId: 's1', finalAssetId: 'f1' }],
      seals: [
        {
          sceneId: 's1',
          productId: 'p',
          name: 'Arroz',
          price: '24,90',
          unit: null,
          startS: 3,
          endS: 6,
        },
      ],
      endcard: 'Loja',
      musicEnabled: true,
      captionsEnabled: true,
      aspectRatio: '9:16',
    };
    const base = computeAssemblyHashV2(asm);
    expect(
      computeAssemblyHashV2({ ...asm, seals: [{ ...asm.seals[0], price: '19,90' }] }),
    ).not.toBe(base);
    expect(
      computeAssemblyHashV2({ ...asm, scenes: [{ sceneId: 's1', finalAssetId: 'f2' }] }),
    ).not.toBe(base);
    expect(computeAssemblyHashV2({ ...asm, captionsEnabled: false })).not.toBe(base);
  });

  it('hashes v2 nunca colidem com os legados do mesmo conteúdo (builder version separada)', () => {
    const legacy = computeSceneStepHashes({
      kitId: 'k',
      kitVersion: 1,
      voiceId: 'v',
      aspectRatio: '9:16',
      actionPrompt: 'oi',
      dialogue: 'oi',
      durationS: 5,
      generation: 1,
    });
    expect(computeTtsHashV2({ dialogue: 'oi', voiceId: 'v', attempt: 1 })).not.toBe(legacy.tts);
  });

  it('computeContentHash é determinístico e independente da ordem das chaves', () => {
    expect(computeContentHash({ a: 1, b: [1, 2] })).toBe(computeContentHash({ b: [1, 2], a: 1 }));
    expect(computeContentHash({ a: 1 })).not.toBe(computeContentHash({ a: 2 }));
  });
});

describe('selectReferences — por função e tipo de cena (ADR §3.4 / P4)', () => {
  const kit = [
    { assetId: 'k0', slot: 0 },
    { assetId: 'k1', slot: 1 },
    { assetId: 'k2', slot: 2 },
    { assetId: 'k3', slot: 3 },
  ];

  it('cena com produto inclui o slot de interação (a lacuna do legado) mantendo o limite de 3', () => {
    const refs = selectReferences({
      sceneType: 'action_voiceover',
      hasProduct: true,
      motionPrompt: 'picks up the box',
      kitReferences: kit,
      maxReferences: 3,
    });
    expect(refs.map((r) => r.assetId)).toEqual(['k0', 'k3', 'k1']);
    expect(refs[0].role).toBe('identity');
    expect(refs[1].role).toBe('interaction');
    expect(refs).toHaveLength(3);
  });

  it('presenter prioriza expressão de fala; sem produto não leva o slot 3', () => {
    const refs = selectReferences({
      sceneType: 'presenter',
      hasProduct: false,
      motionPrompt: 'waves at the camera',
      kitReferences: kit,
      maxReferences: 3,
    });
    expect(refs.map((r) => r.assetId)).toEqual(['k0', 'k2', 'k1']);
    expect(refs.map((r) => r.role)).toEqual(['identity', 'expression', 'angle']);
  });

  it('cenário aprovado entra antes do preenchimento; original só com includeOriginal', () => {
    const refs = selectReferences({
      sceneType: 'action',
      hasProduct: false,
      motionPrompt: 'walks',
      kitReferences: kit,
      environmentAssetId: 'env',
      originalAssetId: 'orig',
      maxReferences: 3,
    });
    expect(refs.map((r) => r.assetId)).toEqual(['k0', 'env', 'k1']);
    const withOriginal = selectReferences({
      sceneType: 'action',
      hasProduct: false,
      motionPrompt: 'walks',
      kitReferences: kit,
      originalAssetId: 'orig',
      includeOriginal: true,
      maxReferences: 2,
    });
    expect(withOriginal.map((r) => r.assetId)).toEqual(['k0', 'orig']);
  });

  it('slot 3 ausente: fallback auditado no reason; slot 0 ausente cai na primeira disponível', () => {
    const refs = selectReferences({
      sceneType: 'action',
      hasProduct: true,
      motionPrompt: 'holds the box',
      kitReferences: [
        { assetId: 'k1', slot: 1 },
        { assetId: 'k2', slot: 2 },
      ],
      maxReferences: 3,
    });
    expect(refs[0]).toMatchObject({ assetId: 'k1', role: 'identity' });
    expect(refs[0].reason).toMatch(/slot 0 ausente/);
    expect(refs.some((r) => /interação ausente/.test(r.reason))).toBe(true);
  });

  it('limite do adaptador é respeitado e configurável', () => {
    expect(
      selectReferences({
        sceneType: 'presenter',
        hasProduct: true,
        motionPrompt: '',
        kitReferences: kit,
        maxReferences: 1,
      }),
    ).toHaveLength(1);
    expect(keyframeReferenceLimit({})).toBe(3);
    expect(keyframeReferenceLimit({ MC_KEYFRAME_MAX_REFERENCES: '5' })).toBe(5);
    expect(keyframeReferenceLimit({ MC_KEYFRAME_MAX_REFERENCES: '0' })).toBe(3);
  });
});

describe('scene_compose — locução sobre ação sem corte silencioso (ADR §3.1/§3.6)', () => {
  it('composeDurationIssue: áudio maior que o clipe além da tolerância bloqueia', () => {
    expect(composeDurationIssue(5000, 4900)).toBeNull();
    expect(composeDurationIssue(5000, 5100)).toBeNull(); // dentro da tolerância
    expect(composeDurationIssue(5000, 5600)).toMatchObject({
      code: 'audio_exceeds_clip',
      excessMs: 600,
    });
    expect(composeDurationIssue(null, 5600)).toBeNull();
  });

  it('voiceoverPlanExcessMs compara TTS medido com a duração do provider (5/10s)', () => {
    expect(voiceoverPlanExcessMs(4800, 5)).toBe(0);
    expect(voiceoverPlanExcessMs(6200, 5)).toBe(1200);
    expect(voiceoverPlanExcessMs(9900, 10)).toBe(0);
  });

  it('args: vídeo copiado, locução única com apad e -t na duração do vídeo; sem -shortest', () => {
    const args = buildSceneComposeArgs({
      videoPath: 'v.mp4',
      audioPath: 'a.mp3',
      output: 'o.mp4',
      videoDurationS: 5.04,
    });
    expect(args).toContain('apad');
    expect(args[args.indexOf('-t') + 1]).toBe('5.040');
    expect(args).not.toContain('-shortest');
    expect(args[args.indexOf('-map') + 1]).toBe('0:v:0');
    expect(args[args.lastIndexOf('-map') + 1]).toBe('1:a:0');
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
  });

  it('composedOutputIssue verifica o arquivo (vídeo + áudio + duração)', () => {
    expect(
      composedOutputIssue({ hasVideo: true, hasAudio: true, durationMs: 5040 }, 5000),
    ).toBeNull();
    expect(composedOutputIssue({ hasVideo: true, hasAudio: false, durationMs: 5000 }, 5000)).toBe(
      'composed_without_audio',
    );
    expect(composedOutputIssue({ hasVideo: true, hasAudio: true, durationMs: 3000 }, 5000)).toBe(
      'composed_duration_mismatch',
    );
  });
});

describe('selos v2 e timeline renderizada (ADR §3.6)', () => {
  const windows: SceneWindowV2[] = [
    { sceneId: 'a', idx: 0, startS: 0, endS: 6.2, finalAssetId: 'fa', captionsMissing: false },
    { sceneId: 'b', idx: 1, startS: 6.2, endS: 14.5, finalAssetId: 'fb', captionsMissing: true },
    { sceneId: 'c', idx: 2, startS: 14.5, endS: 18, finalAssetId: 'fc', captionsMissing: false },
  ];
  const arroz = { id: 'p1', name: 'Arroz', price: '24,90' };
  const feijao = { id: 'p2', name: 'Feijão', price: '8,99' };

  it('selo por associação explícita, em ordem diferente da fala; CTA sem oferta não recebe selo', () => {
    const cues = buildSealCuesV2(windows, [
      { sceneId: 'b', product: arroz, cue: { startS: 2, endS: 8.3 } },
      { sceneId: 'a', product: feijao, cue: { startS: 3.1, endS: 6.2 } },
    ]);
    expect(cues).toEqual([
      { text: 'ARROZ — R$ 24,90', startS: 8.2, endS: 14.5 },
      { text: 'FEIJÃO — R$ 8,99', startS: 3.1, endS: 6.2 },
    ]);
    // legado (rotativo) daria selo à cena c; v2 não
    expect(buildSealCues(windows, [arroz, feijao])).toHaveLength(3);
    expect(cues.some((c) => c.startS >= 14.5)).toBe(false);
  });

  it('cue além da janela é clampado à cena real', () => {
    const cues = buildSealCuesV2(windows, [
      { sceneId: 'c', product: arroz, cue: { startS: 1, endS: 99 } },
    ]);
    expect(cues[0]).toMatchObject({ startS: 15.5, endS: 18 });
  });

  it('buildRenderedTimeline: janelas medidas, cartela após a última cena e legendas ausentes visíveis', () => {
    const seals = [{ sceneId: 'b', product: arroz, cue: { startS: 2, endS: 8.3 } }];
    const sealCues = buildSealCuesV2(windows, seals);
    const timeline = buildRenderedTimeline({
      revision: 1,
      version: 1,
      windows,
      endcardDurationS: 2,
      captionsRequested: true,
      seals,
      sealCues,
      renderedAt: 'now',
    });
    expect(timeline.totalS).toBe(20);
    expect(timeline.endcard).toEqual({ startS: 18, endS: 20 });
    expect(timeline.captionsMissingSceneIds).toEqual(['b']);
    expect(timeline.seals).toEqual([{ sceneId: 'b', productId: 'p1', startS: 8.2, endS: 14.5 }]);
    expect(timeline.scenes[1]).toMatchObject({
      sceneId: 'b',
      startS: 6.2,
      endS: 14.5,
      captionsMissing: true,
    });
    const noEndcard = buildRenderedTimeline({
      revision: 1,
      version: 1,
      windows,
      endcardDurationS: null,
      captionsRequested: false,
      seals: [],
      sealCues: [],
    });
    expect(noEndcard.totalS).toBe(18);
    expect(noEndcard.endcard).toBeNull();
  });
});
