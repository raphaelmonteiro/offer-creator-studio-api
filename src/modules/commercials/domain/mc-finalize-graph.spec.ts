import { escapeDrawtextText } from './mc-assembly-graph';
import {
  buildDuckingFilters,
  buildFinalizeGraph,
  captionLayoutFor,
  dynamicLoudnormPlan,
  encodeProfileFor,
  FinalizeGraphInput,
  FinalizeMeasurePass,
  filterPathValue,
  loudnessWithinTarget,
  MC_FINALIZE_GRAPH_VERSION,
  MC_FINALIZE_LOUDNESS,
  MC_LOUDNORM_MAX_REMEASURES,
  mergeSpeechWindows,
  parseEbur128Metadata,
  planLoudnorm,
  planWhatsappEncode,
  resolveLoudnormPlan,
  whatsappVideoBitrateKbps,
} from './mc-finalize-graph';
import { computeFinalizeHash } from './mc-step-hashes';
import { safeAreaFor } from './mc-talking-art-window';

const input = (over: Partial<FinalizeGraphInput> = {}): FinalizeGraphInput => ({
  sourcePath: '/uploads/composed.mp4',
  output: '/tmp/fin/final.mp4',
  channel: 'instagram',
  width: 1080,
  height: 1920,
  musicPath: '/uploads/music.mp3',
  speechWindows: [
    { sceneId: 'a', startS: 0, endS: 2.5 },
    { sceneId: 'a', startS: 2.8, endS: 6 },
    { sceneId: 'b', startS: 6.2, endS: 9 },
    { sceneId: 'b', startS: 10.3, endS: 13.2 },
  ],
  captionCues: [
    { text: 'Olá! Chegaram as ofertas da semana', startS: 0.1, endS: 2.4 },
    { text: 'Feijão carioca — R$ 8,99!', startS: 6.3, endS: 8.9 },
  ],
  windowPx: { x: 707, y: 837, width: 308, height: 411 },
  loudness: { ...MC_FINALIZE_LOUDNESS },
  durationMs: 13_200,
  ...over,
});

const measured = { I: -21.4, TP: -10.2, LRA: 4.3, thresh: -31.4 };
const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

describe('mc-finalize-graph — legendas, ducking, loudnorm em duas passagens e perfis (tarefa 4.5)', () => {
  it('perfil Instagram: H.264 High 4.1, 30 fps CFR, GOP 30 fechado, CRF com teto 20M/30M, AAC 48 kHz 128k, +faststart', () => {
    expect(MC_FINALIZE_GRAPH_VERSION).toBe(2);
    const plan = buildFinalizeGraph(input());
    const { args } = plan.render(planLoudnorm(measured));
    const joined = args.join(' ');
    for (const piece of [
      '-c:v libx264 -profile:v high -level:v 4.1',
      '-crf 18 -maxrate 20000k -bufsize 30000k -bf 2',
      '-g 30 -keyint_min 30 -sc_threshold 0 -flags +cgop -r 30',
      '-c:a aac -b:a 128k -ar 48000 -ac 2 -movflags +faststart',
    ]) {
      expect(joined).toContain(piece);
    }
    expect(args[args.length - 1]).toBe('/tmp/fin/final.mp4');
    expect(joined).not.toContain('-shortest');
    expect(args).toMatchSnapshot();
  });

  it('perfil WhatsApp: Main 4.0 sem B-frames, bitrate pela duração (≤ 16 MB), maxrate = bufsize = bitrate', () => {
    const plan = buildFinalizeGraph(input({ channel: 'whatsapp' }));
    const { args, profile } = plan.render(planLoudnorm(measured));
    expect(profile).toMatchObject({
      profile: 'main',
      level: '4.0',
      bframes: 0,
      crf: null,
      videoBitrateKbps: 5000, // 13,2 s cabem folgados: teto do canal
      maxBytes: 16_000_000,
      width: 1080,
      height: 1920,
    });
    const joined = args.join(' ');
    expect(joined).toContain('-profile:v main -level:v 4.0');
    expect(joined).toContain('-b:v 5000k -maxrate 5000k -bufsize 5000k -bf 0');
    expect(joined).not.toContain('-crf');
    expect(args).toMatchSnapshot();
    // nova tentativa com bitrate menor (arquivo passou do teto)
    const retry = plan.render(planLoudnorm(measured), { bitrateFactor: 0.8 });
    expect(retry.profile.videoBitrateKbps).toBe(4000);
  });

  it('matemática do WhatsApp: (16 MB × 0,95 − áudio) / (duração + 1 s); reduz bitrate antes da resolução', () => {
    // 25 s: (121,6 Mbit − 3,2 Mbit) / 26 s = 4553 kbps
    expect(whatsappVideoBitrateKbps(25)).toBe(4553);
    // 27 s (25 s de fala + cartela): 4219 kbps — resolução cheia
    expect(planWhatsappEncode(27, 1080, 1920)).toEqual({
      videoKbps: 4219,
      width: 1080,
      height: 1920,
      downscaled: false,
    });
    // 70 s: 1586 kbps — ainda acima do mínimo de 1080p (1500): só o bitrate cai
    expect(planWhatsappEncode(70, 1080, 1920)).toMatchObject({
      videoKbps: 1586,
      downscaled: false,
    });
    // 90 s: 1209 kbps < 1500 → 720p (2/3)
    expect(planWhatsappEncode(90, 1080, 1920)).toEqual({
      videoKbps: 1209,
      width: 720,
      height: 1280,
      downscaled: true,
    });
    // 160 s: 628 kbps < 800 → 540p (1/2)
    expect(planWhatsappEncode(160, 1920, 1080)).toEqual({
      videoKbps: 628,
      width: 960,
      height: 540,
      downscaled: true,
    });
    // tamanho total previsto sempre ≤ 16 MB
    for (const d of [6, 14, 25, 27, 60, 90, 160]) {
      const { videoKbps } = planWhatsappEncode(d, 1080, 1920);
      const bytes = ((videoKbps * (d + 1) + 128 * d) * 1000) / 8;
      expect(bytes).toBeLessThanOrEqual(16_000_000);
    }
    const scaled = buildFinalizeGraph(input({ channel: 'whatsapp', durationMs: 90_000 }));
    expect(graphOf(scaled.render(planLoudnorm(measured)).args)).toContain(
      'scale=720:1280:flags=lanczos',
    );
    expect(encodeProfileFor(null).channel).toBe('instagram');
  });

  it('legendas por linha com buildTimedDrawtext dentro da área segura; faixa sobe para o topo quando a janela ocupa a base', () => {
    const plan = buildFinalizeGraph(input());
    expect(plan.captions.count).toBe(2);
    const layout = plan.captions.layout!;
    const safe = safeAreaFor(1080, 1920);
    expect(layout.position).toBe('top'); // janela padrão no canto inferior direito
    expect(layout.band.top).toBeGreaterThanOrEqual(safe.top);
    expect(layout.band.bottom).toBeLessThanOrEqual(safe.bottom);
    // a linha mais longa (34 caracteres) cabe em 92% da largura segura; 38 também
    expect(34 * 0.62 * layout.style.fontSize).toBeLessThanOrEqual((safe.right - safe.left) * 0.92);
    const full = captionLayoutFor(1080, 1920, [{ text: 'x'.repeat(38), startS: 0, endS: 1 }]);
    expect(38 * 0.62 * full.style.fontSize).toBeLessThanOrEqual((safe.right - safe.left) * 0.92);
    const graph = graphOf(plan.render(planLoudnorm(measured)).args);
    expect(graph).toContain(
      `drawtext=text='${escapeDrawtextText('Feijão carioca — R$ 8,99!')}':fontsize=${layout.style.fontSize}`,
    );
    expect(graph).toContain("enable='between(t,6.30,8.90)'");
    expect(graph).toContain(`y=${safe.top + layout.style.boxBorder}`);
    // sem janela na base: legenda na base da área segura
    const bottom = captionLayoutFor(1080, 1920, input().captionCues, {
      x: 707,
      y: 300,
      width: 308,
      height: 411,
    });
    expect(bottom.position).toBe('bottom');
    expect(bottom.band.bottom).toBe(1248);
    expect(bottom.style.y).toBe(`${1248 - bottom.style.boxBorder}-text_h`);
    // 16:9: 65 px de inset
    expect(captionLayoutFor(1920, 1080, input().captionCues).band.bottom).toBe(1015);
    // sem cues: nenhum drawtext
    const none = buildFinalizeGraph(input({ captionCues: [] }));
    expect(none.captions.layout).toBeNull();
    expect(graphOf(none.render(planLoudnorm(measured)).args)).not.toContain('drawtext');
  });

  it('ducking determinístico: janelas fundidas nas pausas curtas, volume com enable=between e rampas lineares em dB (−15 dB), sem compressor', () => {
    const merged = mergeSpeechWindows(input().speechWindows);
    // 0–2,5 e 2,8–6 e 6,2–9 fundem (pausas de 0,3 e 0,2 s); 9 → 10,3 (1,3 s) fica aberta
    expect(merged).toEqual([
      { startS: 0, endS: 9 },
      { startS: 10.3, endS: 13.2 },
    ]);
    const filters = buildDuckingFilters(merged);
    expect(filters).toEqual([
      "volume='pow(10,-15*min(1,min((t-(-0.12))/0.12,(9.25-t)/0.25))/20)':eval=frame:enable='between(t,0,9.25)'",
      "volume='pow(10,-15*min(1,min((t-(10.18))/0.12,(13.45-t)/0.25))/20)':eval=frame:enable='between(t,10.18,13.45)'",
    ]);
    const plan = buildFinalizeGraph(input());
    expect(plan.ducking).toEqual(merged);
    const graph = graphOf(plan.measure().args);
    expect(graph).toContain('[1:a]aresample=48000,');
    expect(graph).toContain(',volume=0.35,volume=');
    expect(graph).toContain(
      '[speech][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]',
    );
    expect(graph).not.toContain('sidechaincompress');
    // sem trilha: só a fala
    const dry = buildFinalizeGraph(input({ musicPath: null }));
    expect(dry.ducking).toEqual([]);
    expect(graphOf(dry.measure().args)).toContain('[speech]anull[mix]');
    expect(dry.measure().args.filter((a) => a === '-i')).toHaveLength(1);
  });

  it('passe 1 mede a mistura (ebur128 → arquivo), passe 2 aplica loudnorm LINEAR com os valores medidos, -ar 48000; passe 3 mede a entrega', () => {
    const plan = buildFinalizeGraph(input());
    const pass1 = plan.measure();
    expect(pass1.metadataPath).toBe('/tmp/fin/loudness-pass1.txt');
    expect(graphOf(pass1.args)).toContain(
      "[mix]ebur128=peak=true:metadata=1,ametadata=mode=print:file='/tmp/fin/loudness-pass1.txt'[a]",
    );
    expect(pass1.args.slice(-6)).toEqual(['-map', '[a]', '-vn', '-f', 'null', '-']);
    expect(pass1.args.join(' ')).not.toContain('loudnorm');
    const ln = planLoudnorm(measured);
    expect(ln).toMatchObject({ mode: 'linear', gainDb: 7.4, limiterDb: null, nextLimiterDb: null });
    const graph = graphOf(plan.render(ln).args);
    expect(graph).toContain(
      '[mix]loudnorm=I=-14:TP=-2:LRA=11:linear=true:measured_I=-21.40:measured_TP=-10.20:' +
        'measured_LRA=4.30:measured_thresh=-31.40,aresample=48000[a]',
    );
    expect(plan.verify.args).toEqual([
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      '/tmp/fin/final.mp4',
      '-vn',
      '-af',
      "aresample=48000,ebur128=peak=true:metadata=1,ametadata=mode=print:file='/tmp/fin/loudness-final.txt'",
      '-f',
      'null',
      '-',
    ]);
  });

  it('planLoudnorm: pico previsto acima do teto pede re-medição com limitador; LRA elevado ao medido mantém o modo linear', () => {
    const peaky = { I: -24.5, TP: -3.5, LRA: 14.2, thresh: -34.5 };
    const first = planLoudnorm(peaky);
    expect(first.nextLimiterDb).toBe(-13); // −2 − 10,5 − 0,5
    expect(first.lra).toBe(16);
    const limited = planLoudnorm(
      { I: -26, TP: -12.6, LRA: 13, thresh: -36 },
      MC_FINALIZE_LOUDNESS,
      {
        limiterDb: -13,
      },
    );
    // ganho 12 dB: −12,6 + 12 = −0,6 > −2 → desce mais 1,5 dB
    expect(limited).toMatchObject({ mode: 'linear_limited', limiterDb: -13, nextLimiterDb: -14.5 });
    expect(limited.filters[0]).toBe('alimiter=limit=0.22387:attack=5:release=50:level=0');
    const done = planLoudnorm(
      { I: -26.3, TP: -14.4, LRA: 13, thresh: -36.3 },
      MC_FINALIZE_LOUDNESS,
      {
        limiterDb: -14.5,
      },
    );
    expect(done.nextLimiterDb).toBeNull();
    expect(done.filters[1]).toContain('measured_I=-26.30:measured_TP=-14.40');
    expect(dynamicLoudnormPlan().filters).toEqual(['loudnorm=I=-14:TP=-2:LRA=11']);
  });

  it('resolveLoudnormPlan: mede, re-mede com o limitador pedido até convergir; silêncio cai no modo dinâmico', async () => {
    const plan = buildFinalizeGraph(input());
    const seen: FinalizeMeasurePass[] = [];
    const results = [
      { I: -24.5, TP: -3.5, LRA: 2, thresh: -34.5 },
      { I: -26, TP: -12.6, LRA: 2, thresh: -36 },
      { I: -26.3, TP: -14.4, LRA: 2, thresh: -36.3 },
    ];
    const resolved = await resolveLoudnormPlan(plan.measure, async (pass) => {
      seen.push(pass);
      return results[seen.length - 1];
    });
    expect(seen.map((p) => p.metadataPath)).toEqual([
      '/tmp/fin/loudness-pass1.txt',
      '/tmp/fin/loudness-pass1-lim1300.txt',
      '/tmp/fin/loudness-pass1-lim1450.txt',
    ]);
    expect(graphOf(seen[1].args)).toContain(
      '[mix]alimiter=limit=0.22387:attack=5:release=50:level=0,ebur128',
    );
    expect(resolved.pass1).toEqual(results[0]);
    expect(resolved.loudnorm).toMatchObject({ mode: 'linear_limited', limiterDb: -14.5 });
    expect(resolved.measurements.map((m) => m.limiterDb)).toEqual([null, -13, -14.5]);
    const silent = await resolveLoudnormPlan(plan.measure, async () => null);
    expect(silent.loudnorm.mode).toBe('dynamic');
    // não converge (o limitador não baixa o pico): para no teto de re-medições e registra `dynamic`
    let calls = 0;
    const stuck = await resolveLoudnormPlan(plan.measure, async () => {
      calls += 1;
      return { I: -24.5, TP: -3.5, LRA: 2, thresh: -34.5 };
    });
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(1 + MC_LOUDNORM_MAX_REMEASURES);
    expect(stuck.loudnorm.mode).toBe('dynamic');
  });

  it('parseEbur128Metadata: último bloco do ametadata (I, LRA, picos reais lineares → dBTP); silêncio → null', () => {
    const text = [
      'frame:0    pts:0       pts_time:0',
      'lavfi.r128.M=-120.691',
      'lavfi.r128.I=-70.000',
      'frame:89   pts:427200  pts_time:8.9',
      'lavfi.r128.M=-18.2',
      'lavfi.r128.S=-17.9',
      'lavfi.r128.I=-14.032',
      'lavfi.r128.LRA=3.100',
      'lavfi.r128.true_peaks_ch0=0.794',
      'lavfi.r128.true_peaks_ch1=0.851',
      'lavfi.r128.true_peak=0.851',
    ].join('\n');
    expect(parseEbur128Metadata(text)).toEqual({ I: -14.03, TP: -1.4, LRA: 3.1, thresh: -24.03 });
    expect(parseEbur128Metadata('lavfi.r128.I=-70.000\n')).toBeNull();
    expect(parseEbur128Metadata('')).toBeNull();
    expect(loudnessWithinTarget({ I: -14.03, TP: -1.4 })).toBe(true);
    expect(loudnessWithinTarget({ I: -15.2, TP: -1.4 })).toBe(false);
    expect(loudnessWithinTarget({ I: -14, TP: -0.9 })).toBe(false);
    expect(filterPathValue('/tmp/a:b/x.txt')).toBe("'/tmp/a\\:b/x.txt'");
    expect(() => filterPathValue("/tmp/it's")).toThrow();
  });

  it('hash do finalize muda com o compose, canal, trilha, legendas, loudness e versão do grafo', () => {
    const base = {
      composeHash: 'c1',
      channel: 'instagram',
      musicEnabled: true,
      captionsEnabled: true,
      loudness: { I: -14, TP: -1 },
      graphVersion: MC_FINALIZE_GRAPH_VERSION,
    };
    const h = computeFinalizeHash(base);
    expect(computeFinalizeHash({ ...base })).toBe(h);
    expect(computeFinalizeHash({ ...base, channel: 'whatsapp' })).not.toBe(h);
    expect(computeFinalizeHash({ ...base, musicEnabled: false })).not.toBe(h);
    expect(computeFinalizeHash({ ...base, composeHash: 'c2' })).not.toBe(h);
    expect(computeFinalizeHash({ ...base, graphVersion: 1 })).not.toBe(h);
  });
});
