import {
  buildSpeechTimeline,
  buildTalkConformArgs,
  centerCropToAspect,
  conformedOutputIssue,
  MC_TALK_EVEN_DIMS_FILTER,
  MC_TALK_GAP_MS,
  planTalkConform,
} from './mc-talk-conform-graph';

describe('mc-talk-conform-graph — clipe conformado ao áudio (design D7, tarefa 3.5)', () => {
  const geometry = {
    videoWidth: 720,
    videoHeight: 960,
    tileWidth: 720,
    tileHeight: 960,
  };

  describe('duração: áudio é a timeline mestre', () => {
    it('clipe mais LONGO que o áudio → aparado (-t áudio), sem tpad', () => {
      const plan = planTalkConform({ videoMs: 7400, audioMs: 6000, ...geometry });
      expect(plan.durationAction).toBe('trim');
      expect(plan.deltaMs).toBe(-1400);
      expect(plan.padS).toBe(0);
      const args = buildTalkConformArgs({
        videoPath: 'v.mp4',
        audioPath: 'a.mp3',
        output: 'out.mp4',
        plan,
        audioDurationS: 6,
      });
      expect(args).toEqual(expect.arrayContaining(['-t', '6.000']));
      expect(args.join(' ')).not.toContain('tpad');
      expect(args).not.toContain('-shortest');
      expect(args.join(' ')).not.toContain('atempo');
    });

    it('clipe 200 ms mais CURTO → último quadro clonado até a duração do áudio', () => {
      const plan = planTalkConform({ videoMs: 5800, audioMs: 6000, ...geometry });
      expect(plan.durationAction).toBe('pad');
      expect(plan.deltaMs).toBe(200);
      expect(plan.padS).toBeCloseTo(0.2 + 1 / 30, 3);
      const args = buildTalkConformArgs({
        videoPath: 'v.mp4',
        audioPath: 'a.mp3',
        output: 'out.mp4',
        plan,
        audioDurationS: 6,
      });
      const vf = args[args.indexOf('-vf') + 1];
      expect(vf).toContain('tpad=stop_mode=clone:stop_duration=0.233');
      expect(args).toEqual(expect.arrayContaining(['-t', '6.000']));
    });

    it('exatamente 300 ms ainda clona; 301 ms já é too_short', () => {
      expect(planTalkConform({ videoMs: 5700, audioMs: 6000, ...geometry }).durationAction).toBe(
        'pad',
      );
      expect(planTalkConform({ videoMs: 5699, audioMs: 6000, ...geometry }).durationAction).toBe(
        'too_short',
      );
    });

    it('clipe 1,2 s mais curto → too_short (classe quality: boca parada), sem comando ffmpeg', () => {
      const plan = planTalkConform({ videoMs: 4800, audioMs: 6000, ...geometry });
      expect(plan.durationAction).toBe('too_short');
      expect(plan.deltaMs).toBe(1200);
      expect(() =>
        buildTalkConformArgs({
          videoPath: 'v.mp4',
          audioPath: 'a.mp3',
          output: 'out.mp4',
          plan,
          audioDurationS: 6,
        }),
      ).toThrow(/too_short/);
    });

    it('teto da classe quality esgotado (H1): replanejar com padMaxMs infinito clona o último quadro até o áudio', () => {
      const plan = planTalkConform({
        videoMs: 4800,
        audioMs: 6000,
        ...geometry,
        padMaxMs: Infinity,
      });
      expect(plan.durationAction).toBe('pad');
      expect(plan.deltaMs).toBe(1200);
      expect(plan.padS).toBeCloseTo(1.2 + 1 / 30, 3);
      const args = buildTalkConformArgs({
        videoPath: 'v.mp4',
        audioPath: 'a.mp3',
        output: 'out.mp4',
        plan,
        audioDurationS: 6,
      });
      const vf = args[args.indexOf('-vf') + 1];
      expect(vf).toContain('tpad=stop_mode=clone:stop_duration=1.233');
      expect(args).toEqual(expect.arrayContaining(['-t', '6.000']));
      expect(args).not.toContain('-shortest');
    });

    it('duração igual → keep (ainda assim -t do áudio e TTS original muxado)', () => {
      const plan = planTalkConform({ videoMs: 6000, audioMs: 6000, ...geometry });
      expect(plan.durationAction).toBe('keep');
      const args = buildTalkConformArgs({
        videoPath: 'v.mp4',
        audioPath: 'a.mp3',
        output: 'out.mp4',
        plan,
        audioDurationS: 6,
      });
      // áudio do fornecedor descartado: só o stream 1 (TTS) é mapeado
      expect(args).toEqual(expect.arrayContaining(['-map', '0:v:0', '-map', '1:a:0']));
      expect(args.filter((a) => a === '-map')).toHaveLength(2);
      expect(args).toEqual(expect.arrayContaining(['-af', 'apad', '-c:a', 'aac', '-ar', '48000']));
    });
  });

  describe('geometria: aspecto do tile com tolerância de 2%, recorte centralizado, nunca barras', () => {
    it('tile 3:4 e clipe 9:16 → recorte centralizado para 3:4 (corta topo/base)', () => {
      const crop = centerCropToAspect(720, 1280, 720, 960);
      expect(crop).toEqual({ width: 720, height: 960, x: 0, y: 160 });
      const plan = planTalkConform({
        videoMs: 6000,
        audioMs: 6000,
        videoWidth: 720,
        videoHeight: 1280,
        tileWidth: 720,
        tileHeight: 960,
      });
      expect(plan.crop).toEqual(crop);
      expect(plan.outputWidth).toBe(720);
      expect(plan.outputHeight).toBe(960);
      const args = buildTalkConformArgs({
        videoPath: 'v.mp4',
        audioPath: 'a.mp3',
        output: 'out.mp4',
        plan,
        audioDurationS: 6,
      });
      const vf = args[args.indexOf('-vf') + 1];
      expect(vf.startsWith('crop=720:960:0:160,')).toBe(true);
      expect(vf).not.toContain('pad=');
    });

    it('clipe mais largo que o tile → corta as laterais; dimensões pares', () => {
      expect(centerCropToAspect(1280, 720, 1, 1)).toEqual({
        width: 720,
        height: 720,
        x: 280,
        y: 0,
      });
      expect(centerCropToAspect(1281, 721, 3, 4)).toMatchObject({ width: 540, height: 720 });
    });

    it('sem recorte de aspecto, largura/altura ÍMPAR → crop=trunc(iw/2)*2:trunc(ih/2)*2 e medidas pares', () => {
      const vfOf = (plan: ReturnType<typeof planTalkConform>) => {
        const args = buildTalkConformArgs({
          videoPath: 'v.mp4',
          audioPath: 'a.mp3',
          output: 'out.mp4',
          plan,
          audioDurationS: 6,
        });
        return args[args.indexOf('-vf') + 1];
      };
      // 721×961 vs 3:4: dentro da tolerância (sem recorte de aspecto), mas ímpar
      const odd = planTalkConform({
        videoMs: 6000,
        audioMs: 6000,
        videoWidth: 721,
        videoHeight: 961,
        tileWidth: 720,
        tileHeight: 960,
      });
      expect(odd.crop).toBeNull();
      expect(odd.forceEvenDims).toBe(true);
      expect([odd.outputWidth, odd.outputHeight]).toEqual([720, 960]);
      expect(vfOf(odd).startsWith(`${MC_TALK_EVEN_DIMS_FILTER},fps=30,`)).toBe(true);
      // só uma das dimensões ímpar também apara
      expect(
        planTalkConform({ ...geometry, videoMs: 6000, audioMs: 6000, videoHeight: 961 })
          .forceEvenDims,
      ).toBe(true);
      // dimensões pares: sem o filtro
      const evenPlan = planTalkConform({ videoMs: 6000, audioMs: 6000, ...geometry });
      expect(evenPlan.forceEvenDims).toBe(false);
      expect(vfOf(evenPlan)).not.toContain('trunc');
      // recorte de aspecto já sai par: o filtro de paridade não entra
      const cropped = planTalkConform({
        videoMs: 6000,
        audioMs: 6000,
        videoWidth: 721,
        videoHeight: 1281,
        tileWidth: 720,
        tileHeight: 960,
      });
      expect(cropped.crop).toEqual({ width: 720, height: 960, x: 0, y: 160 });
      expect(cropped.forceEvenDims).toBe(false);
      expect(vfOf(cropped)).not.toContain('trunc');
      // dimensões desconhecidas: nada a aparar
      expect(
        planTalkConform({
          videoMs: 6000,
          audioMs: 6000,
          videoWidth: null,
          videoHeight: null,
          tileWidth: null,
          tileHeight: null,
        }).forceEvenDims,
      ).toBe(false);
    });

    it('dentro da tolerância de 2% não recorta; sem dimensões do tile não checa', () => {
      expect(centerCropToAspect(720, 966, 720, 960)).toBeNull(); // 0,6% de diferença
      expect(centerCropToAspect(720, 990, 720, 960)).not.toBeNull(); // 3%
      const plan = planTalkConform({
        videoMs: 6000,
        audioMs: 6000,
        videoWidth: 720,
        videoHeight: 1280,
        tileWidth: null,
        tileHeight: null,
      });
      expect(plan.crop).toBeNull();
      expect(plan.outputWidth).toBe(720);
      expect(plan.outputHeight).toBe(1280);
    });
  });

  it('verificação do arquivo conformado: vídeo + áudio e duração igual à do áudio', () => {
    expect(
      conformedOutputIssue({ hasVideo: true, hasAudio: true, durationMs: 6050 }, 6000),
    ).toBeNull();
    expect(conformedOutputIssue({ hasVideo: false, hasAudio: true, durationMs: 6000 }, 6000)).toBe(
      'conformed_without_video',
    );
    expect(conformedOutputIssue({ hasVideo: true, hasAudio: false, durationMs: 6000 }, 6000)).toBe(
      'conformed_without_audio',
    );
    expect(conformedOutputIssue({ hasVideo: true, hasAudio: true, durationMs: 6500 }, 6000)).toBe(
      'conformed_duration_mismatch',
    );
  });

  describe('timeline das falas (D7: soma das durações medidas + silêncios)', () => {
    it('três falas de 6 s, 7 s e 5 s: a terceira começa entre 13,3 e 13,5 s; total entre 18,3 e 18,5 s', () => {
      const { entries, totalMs } = buildSpeechTimeline([
        { sceneId: 'a', durationMs: 6000 },
        { sceneId: 'b', durationMs: 7000 },
        { sceneId: 'c', durationMs: 5000 },
      ]);
      expect(MC_TALK_GAP_MS).toBeGreaterThanOrEqual(150);
      expect(MC_TALK_GAP_MS).toBeLessThanOrEqual(250);
      expect(entries[0]).toEqual({ sceneId: 'a', startMs: 0, endMs: 6000 });
      expect(entries[1].startMs).toBe(6000 + MC_TALK_GAP_MS);
      expect(entries[2].startMs).toBeGreaterThanOrEqual(13300);
      expect(entries[2].startMs).toBeLessThanOrEqual(13500);
      expect(totalMs).toBeGreaterThanOrEqual(18300);
      expect(totalMs).toBeLessThanOrEqual(18500);
    });

    it('uma fala só não tem silêncio; durações medidas (não planejadas) são o que conta', () => {
      expect(buildSpeechTimeline([{ sceneId: 'a', durationMs: 4321 }])).toEqual({
        entries: [{ sceneId: 'a', startMs: 0, endMs: 4321 }],
        totalMs: 4321,
      });
      expect(buildSpeechTimeline([])).toEqual({ entries: [], totalMs: 0 });
    });
  });
});
