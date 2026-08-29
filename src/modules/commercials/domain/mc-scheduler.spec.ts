import { SchedulerScene, SchedulerStep, readySteps, sceneFinalStepType } from './mc-scheduler';
import { McProjectStatus, McSceneStatus, McStepStatus } from './mc-state-machines';
import { McStepType } from './mc-types';

/** Fábricas mínimas — só o que o scheduler enxerga. */
let seq = 0;
function scene(over: Partial<SchedulerScene> = {}): SchedulerScene {
  return {
    id: over.id ?? `scene-${++seq}`,
    idx: over.idx ?? 0,
    generation: over.generation ?? 1,
    status: over.status ?? McSceneStatus.PENDING,
    dialogue: over.dialogue !== undefined ? over.dialogue : null,
  };
}
function step(type: McStepType, over: Partial<SchedulerStep> = {}): SchedulerStep {
  return {
    id: over.id ?? `step-${type}-${++seq}`,
    sceneId: over.sceneId !== undefined ? over.sceneId : null,
    sceneGeneration: over.sceneGeneration !== undefined ? over.sceneGeneration : null,
    type,
    status: over.status ?? McStepStatus.PENDING,
  };
}
/** Steps da geração `gen` de uma cena, com status por tipo. */
function sceneSteps(
  s: SchedulerScene,
  statuses: Partial<Record<McStepType, McStepStatus>>,
  gen = s.generation,
): SchedulerStep[] {
  return (Object.keys(statuses) as McStepType[]).map((type) =>
    step(type, { sceneId: s.id, sceneGeneration: gen, status: statuses[type] }),
  );
}
const ids = (refs: { id: string }[]) => refs.map((r) => r.id).sort();
const types = (refs: { type: McStepType }[]) => refs.map((r) => r.type).sort();

describe('readySteps (plano-comerciais §6.2 — topologia fixa)', () => {
  it('projeto em scripting: só o step script (nível projeto) desbloqueia', () => {
    const script = step(McStepType.SCRIPT);
    const refs = readySteps({ status: McProjectStatus.SCRIPTING }, [], [script]);
    expect(ids(refs)).toEqual([script.id]);
  });

  it('estados sem agendamento (draft, storyboard_review, needs_attention, terminais) retornam vazio', () => {
    const s = scene({ dialogue: 'Olá!' });
    const steps = [
      step(McStepType.SCRIPT),
      ...sceneSteps(s, { [McStepType.KEYFRAME]: McStepStatus.PENDING }),
    ];
    for (const status of [
      McProjectStatus.DRAFT,
      McProjectStatus.STORYBOARD_REVIEW,
      McProjectStatus.NEEDS_ATTENTION,
      McProjectStatus.SUCCEEDED,
      McProjectStatus.FAILED,
      McProjectStatus.CANCELED,
    ]) {
      expect(readySteps({ status }, [s], steps)).toEqual([]);
    }
  });

  it('estado inicial em generating (cena falada): keyframe e tts em paralelo; video e lipsync travados', () => {
    const s = scene({ dialogue: 'Bem-vindo às ofertas da semana!' });
    const steps = sceneSteps(s, {
      [McStepType.KEYFRAME]: McStepStatus.PENDING,
      [McStepType.VIDEO]: McStepStatus.PENDING,
      [McStepType.TTS]: McStepStatus.PENDING,
      [McStepType.LIPSYNC]: McStepStatus.PENDING,
    });
    const refs = readySteps({ status: McProjectStatus.GENERATING }, [s], steps);
    expect(types(refs)).toEqual([McStepType.KEYFRAME, McStepType.TTS]);
  });

  it('destravamento em cadeia: keyframe pronto libera video; video+tts prontos liberam lipsync', () => {
    const s = scene({ dialogue: 'Olá!' });
    // keyframe pronto → video libera (tts ainda rodando)
    let steps = sceneSteps(s, {
      [McStepType.KEYFRAME]: McStepStatus.SUCCEEDED,
      [McStepType.VIDEO]: McStepStatus.PENDING,
      [McStepType.TTS]: McStepStatus.RUNNING,
      [McStepType.LIPSYNC]: McStepStatus.PENDING,
    });
    expect(types(readySteps({ status: McProjectStatus.GENERATING }, [s], steps))).toEqual([
      McStepType.VIDEO,
    ]);

    // video pronto mas tts ainda rodando → lipsync NÃO libera
    steps = sceneSteps(s, {
      [McStepType.KEYFRAME]: McStepStatus.SUCCEEDED,
      [McStepType.VIDEO]: McStepStatus.SUCCEEDED,
      [McStepType.TTS]: McStepStatus.RUNNING,
      [McStepType.LIPSYNC]: McStepStatus.PENDING,
    });
    expect(readySteps({ status: McProjectStatus.GENERATING }, [s], steps)).toEqual([]);

    // video + tts prontos → lipsync libera
    steps = sceneSteps(s, {
      [McStepType.KEYFRAME]: McStepStatus.SUCCEEDED,
      [McStepType.VIDEO]: McStepStatus.SUCCEEDED,
      [McStepType.TTS]: McStepStatus.SUCCEEDED,
      [McStepType.LIPSYNC]: McStepStatus.PENDING,
    });
    expect(types(readySteps({ status: McProjectStatus.GENERATING }, [s], steps))).toEqual([
      McStepType.LIPSYNC,
    ]);
  });

  it('REGRESSÃO (1ª produção real): lipsync NÃO libera com tts pronto + video skipped se o keyframe ainda roda', () => {
    // Fluxo audio-driven: video nasce skipped_cached; TTS real (2s) termina
    // antes do keyframe Gemini (~15s). Sem a dependência direta do keyframe,
    // o Avatar era submetido sem imagem ("Cena sem keyframe pronto").
    const s = scene({ dialogue: 'Oi!' });
    const racing = sceneSteps(s, {
      [McStepType.KEYFRAME]: McStepStatus.RUNNING,
      [McStepType.VIDEO]: McStepStatus.SKIPPED_CACHED,
      [McStepType.TTS]: McStepStatus.SUCCEEDED,
      [McStepType.LIPSYNC]: McStepStatus.PENDING,
    });
    expect(types(readySteps({ status: McProjectStatus.GENERATING }, [s], racing))).toEqual([]);

    // keyframe concluiu → agora sim o lipsync desbloqueia
    const done = sceneSteps(s, {
      [McStepType.KEYFRAME]: McStepStatus.SUCCEEDED,
      [McStepType.VIDEO]: McStepStatus.SKIPPED_CACHED,
      [McStepType.TTS]: McStepStatus.SUCCEEDED,
      [McStepType.LIPSYNC]: McStepStatus.PENDING,
    });
    expect(types(readySteps({ status: McProjectStatus.GENERATING }, [s], done))).toEqual([
      McStepType.LIPSYNC,
    ]);
  });

  it('cena sem fala não tem tts/lipsync: finaliza no video', () => {
    const s = scene({ dialogue: null });
    expect(sceneFinalStepType(s)).toBe(McStepType.VIDEO);
    expect(sceneFinalStepType({ dialogue: 'Oi!' })).toBe(McStepType.LIPSYNC);

    const steps = sceneSteps(s, {
      [McStepType.KEYFRAME]: McStepStatus.SUCCEEDED,
      [McStepType.VIDEO]: McStepStatus.PENDING,
    });
    expect(types(readySteps({ status: McProjectStatus.GENERATING }, [s], steps))).toEqual([
      McStepType.VIDEO,
    ]);
  });

  it('skipped_cached conta como succeeded para dependências (§6.3)', () => {
    const s = scene({ dialogue: null });
    const steps = sceneSteps(s, {
      [McStepType.KEYFRAME]: McStepStatus.SKIPPED_CACHED,
      [McStepType.VIDEO]: McStepStatus.PENDING,
    });
    expect(types(readySteps({ status: McProjectStatus.GENERATING }, [s], steps))).toEqual([
      McStepType.VIDEO,
    ]);
  });

  it('re-roll (generation bump): steps da geração antiga são ignorados', () => {
    const s = scene({ dialogue: 'Olá!', generation: 2, status: McSceneStatus.PENDING });
    const oldGen = sceneSteps(
      s,
      {
        [McStepType.KEYFRAME]: McStepStatus.SUCCEEDED,
        [McStepType.VIDEO]: McStepStatus.SUCCEEDED, // "veio errado" — não vale como dependência
        [McStepType.TTS]: McStepStatus.SUCCEEDED,
        [McStepType.LIPSYNC]: McStepStatus.PENDING, // pendente antigo — não pode ser candidato
      },
      1,
    );
    // geração 2: keyframe/tts reaproveitados como skipped_cached, video re-roda
    const newGen = sceneSteps(s, {
      [McStepType.KEYFRAME]: McStepStatus.SKIPPED_CACHED,
      [McStepType.VIDEO]: McStepStatus.PENDING,
      [McStepType.TTS]: McStepStatus.SKIPPED_CACHED,
      [McStepType.LIPSYNC]: McStepStatus.PENDING,
    });
    const refs = readySteps({ status: McProjectStatus.GENERATING }, [s], [...oldGen, ...newGen]);
    // só o video da geração 2 — o lipsync antigo não aparece, o novo espera o video
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe(McStepType.VIDEO);
    expect(newGen.some((st) => st.id === refs[0].id)).toBe(true);
  });

  it('assembly só desbloqueia com TODAS as cenas da geração corrente prontas', () => {
    const spoken = scene({ id: 'sc-1', idx: 0, dialogue: 'Olá!', status: McSceneStatus.RUNNING });
    const mute = scene({ id: 'sc-2', idx: 1, dialogue: null, status: McSceneStatus.RUNNING });
    const assembly = step(McStepType.ASSEMBLY);

    // cena falada pronta, cena muda ainda sem video → assembly travado
    const partial = [
      ...sceneSteps(spoken, {
        [McStepType.KEYFRAME]: McStepStatus.SUCCEEDED,
        [McStepType.VIDEO]: McStepStatus.SUCCEEDED,
        [McStepType.TTS]: McStepStatus.SUCCEEDED,
        [McStepType.LIPSYNC]: McStepStatus.SUCCEEDED,
      }),
      ...sceneSteps(mute, {
        [McStepType.KEYFRAME]: McStepStatus.SUCCEEDED,
        [McStepType.VIDEO]: McStepStatus.RUNNING,
      }),
      assembly,
    ];
    expect(readySteps({ status: McProjectStatus.GENERATING }, [spoken, mute], partial)).toEqual([]);

    // todas prontas (falada pelo lipsync, muda pelo video) → assembly libera
    const complete = [
      ...sceneSteps(spoken, {
        [McStepType.KEYFRAME]: McStepStatus.SUCCEEDED,
        [McStepType.VIDEO]: McStepStatus.SUCCEEDED,
        [McStepType.TTS]: McStepStatus.SUCCEEDED,
        [McStepType.LIPSYNC]: McStepStatus.SUCCEEDED,
      }),
      ...sceneSteps(mute, {
        [McStepType.KEYFRAME]: McStepStatus.SKIPPED_CACHED,
        [McStepType.VIDEO]: McStepStatus.SUCCEEDED,
      }),
      assembly,
    ];
    const refs = readySteps({ status: McProjectStatus.GENERATING }, [spoken, mute], complete);
    expect(ids(refs)).toEqual([assembly.id]);
    // idempotência de fase: em assembling o assembly ainda desbloqueia, cenas não re-agendam
    expect(
      ids(readySteps({ status: McProjectStatus.ASSEMBLING }, [spoken, mute], complete)),
    ).toEqual([assembly.id]);
  });

  it('assembly não desbloqueia sem cenas nem com cena falada só com video pronto', () => {
    const assembly = step(McStepType.ASSEMBLY);
    // sem cenas materializadas → nada
    expect(readySteps({ status: McProjectStatus.GENERATING }, [], [assembly])).toEqual([]);
    // cena falada: video pronto NÃO é final (falta lipsync)
    const s = scene({ dialogue: 'Olá!' });
    const steps = [
      ...sceneSteps(s, {
        [McStepType.KEYFRAME]: McStepStatus.SUCCEEDED,
        [McStepType.VIDEO]: McStepStatus.SUCCEEDED,
        [McStepType.TTS]: McStepStatus.SUCCEEDED,
        [McStepType.LIPSYNC]: McStepStatus.RUNNING,
      }),
      assembly,
    ];
    const refs = readySteps({ status: McProjectStatus.GENERATING }, [s], steps);
    expect(refs.map((r) => r.type)).not.toContain(McStepType.ASSEMBLY);
  });

  it('cena failed/canceled não agenda steps; cancelada não trava o assembly', () => {
    const failed = scene({ id: 'sc-f', dialogue: null, status: McSceneStatus.FAILED });
    const canceled = scene({ id: 'sc-c', dialogue: null, status: McSceneStatus.CANCELED });
    const ok = scene({ id: 'sc-ok', dialogue: null, status: McSceneStatus.READY });
    const assembly = step(McStepType.ASSEMBLY);
    const steps = [
      ...sceneSteps(failed, { [McStepType.KEYFRAME]: McStepStatus.PENDING }),
      ...sceneSteps(canceled, { [McStepType.KEYFRAME]: McStepStatus.PENDING }),
      ...sceneSteps(ok, {
        [McStepType.KEYFRAME]: McStepStatus.SUCCEEDED,
        [McStepType.VIDEO]: McStepStatus.SUCCEEDED,
      }),
      assembly,
    ];
    // failed espera re-roll; canceled fica de fora — mas failed sem final TRAVA o assembly
    expect(
      readySteps({ status: McProjectStatus.GENERATING }, [failed, canceled, ok], steps),
    ).toEqual([]);
    // sem a cena failed, a cancelada não impede a montagem
    const refs = readySteps({ status: McProjectStatus.GENERATING }, [canceled, ok], steps);
    expect(ids(refs)).toEqual([assembly.id]);
  });
});
