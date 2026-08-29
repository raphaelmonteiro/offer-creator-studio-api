import { FfmpegGraphBuilder, RenderSpec } from './ffmpeg-graph-builder';
import {
  MAX_RENDER_DURATION_MS,
  MIN_DURATION_MS_BY_FORMAT,
  SyncedClipLayer,
  SyncedClipError,
  computeFinalDurationMs,
  expandSyncedClips,
  layerEndMs,
} from './synced-clip';

function clip(overrides: Partial<SyncedClipLayer> = {}): SyncedClipLayer {
  return {
    type: 'synced_clip',
    id: 'fala1',
    video: { filePath: '/uploads/mascote.webm', x: 0.68, y: 0.55, w: 0.3, h: 0.42, hasAlpha: true },
    audio: { filePath: '/uploads/voz.mp3', volume: 1 },
    startMs: 1000,
    zIndex: 40,
    ...overrides,
  };
}

describe('synced_clip — contrato (spike §3.5)', () => {
  describe('expandSyncedClips', () => {
    it('expande em exatamente duas camadas: vídeo (mascot) + áudio', () => {
      const [video, audio] = expandSyncedClips([clip()], 8000);
      expect(video.type).toBe('mascot');
      expect(audio.type).toBe('audio');
      expect(video.filePath).toBe('/uploads/mascote.webm');
      expect(audio.filePath).toBe('/uploads/voz.mp3');
    });

    it('INVARIANTE: vídeo e áudio saem sempre com o MESMO startMs', () => {
      const casos = [0, 1, 250, 1000, 4321, 29999];
      for (const startMs of casos) {
        const [video, audio] = expandSyncedClips([clip({ startMs })], 30000);
        expect(video.startMs).toBe(startMs);
        expect(audio.startMs).toBe(startMs);
        expect(video.startMs).toBe(audio.startMs);
      }
    });

    it('startMs ausente ou negativo vira 0 nos dois lados', () => {
      const [v1, a1] = expandSyncedClips([clip({ startMs: undefined })], 5000);
      expect([v1.startMs, a1.startMs]).toEqual([0, 0]);
      const [v2, a2] = expandSyncedClips([clip({ startMs: -500 })], 5000);
      expect([v2.startMs, a2.startMs]).toEqual([0, 0]);
    });

    it('fala mais curta que o clipe ⇒ vídeo em loop até o fim, áudio termina antes', () => {
      const [video, audio] = expandSyncedClips(
        [clip({ startMs: 1000, audio: { filePath: '/uploads/voz.mp3', durationMs: 2000 } })],
        10000,
      );
      // idle em loop: nunca frame congelado nem corte seco
      expect(video.loop).toBe(true);
      expect(video.endMs).toBe(10000);
      expect(audio.endMs).toBe(3000);
    });

    it('endMs explícito do clipe limita os dois lados', () => {
      const [video, audio] = expandSyncedClips(
        [
          clip({
            startMs: 1000,
            endMs: 4000,
            audio: { filePath: '/uploads/voz.mp3', durationMs: 9000 },
          }),
        ],
        20000,
      );
      expect(video.endMs).toBe(4000);
      expect(audio.endMs).toBe(4000);
    });

    it('preserva zIndex e geometria do vídeo, e o volume do áudio', () => {
      const [video, audio] = expandSyncedClips([clip()], 8000);
      expect(video).toMatchObject({
        x: 0.68,
        y: 0.55,
        w: 0.3,
        h: 0.42,
        zIndex: 40,
        hasAlpha: true,
      });
      expect(audio.volume).toBe(1);
    });

    it('camadas que não são clipe passam intactas e na mesma ordem', () => {
      const bg = { type: 'video' as const, filePath: '/uploads/bg.mp4', x: 0, y: 0, w: 1, h: 1 };
      const overlay = { type: 'image_overlay' as const, filePath: '/uploads/ov.png' };
      const out = expandSyncedClips([bg, clip(), overlay], 8000);
      expect(out.map((l) => l.type)).toEqual(['video', 'mascot', 'audio', 'image_overlay']);
      expect(out[0]).toBe(bg);
      expect(out[3]).toBe(overlay);
    });

    it('clipe sem vídeo ou sem áudio é rejeitado', () => {
      expect(() => expandSyncedClips([clip({ audio: undefined })], 5000)).toThrow(SyncedClipError);
      expect(() => expandSyncedClips([clip({ video: undefined })], 5000)).toThrow(SyncedClipError);
    });
  });

  describe('regras de duração final', () => {
    it('usa o fim do clipe mais longo quando ele passa da duração pedida', () => {
      const layers = [clip({ startMs: 2000, audio: { filePath: 'a', durationMs: 9000 } })];
      expect(computeFinalDurationMs(layers, 'mp4', 5000)).toBe(11000);
    });

    it('respeita o mínimo do formato', () => {
      expect(computeFinalDurationMs([], 'mp4', 1000)).toBe(MIN_DURATION_MS_BY_FORMAT.mp4);
      expect(computeFinalDurationMs([], 'gif', 1000)).toBe(MIN_DURATION_MS_BY_FORMAT.gif);
    });

    it('respeita a duração pedida quando ela é a maior', () => {
      expect(computeFinalDurationMs([clip({ startMs: 0, endMs: 4000 })], 'mp4', 12000)).toBe(12000);
    });

    it('nunca passa do teto de 30s', () => {
      const layers = [clip({ startMs: 25000, audio: { filePath: 'a', durationMs: 20000 } })];
      expect(computeFinalDurationMs(layers, 'mp4', 30000)).toBe(MAX_RENDER_DURATION_MS);
    });

    it('background mais curto NÃO encurta o resultado (fica com -stream_loop)', () => {
      const bg = {
        type: 'video' as const,
        filePath: 'bg.mp4',
        startMs: 0,
        endMs: 2000,
        loop: true,
      };
      const layers = [bg, clip({ startMs: 0, endMs: 9000 })];
      expect(computeFinalDurationMs(layers, 'mp4', 0)).toBe(9000);
    });

    it('layerEndMs: sem endMs usa startMs + duração intrínseca', () => {
      expect(layerEndMs(clip({ startMs: 1500, video: { filePath: 'v', durationMs: 4000 } }))).toBe(
        5500,
      );
      expect(layerEndMs({ type: 'audio', filePath: 'a', startMs: 300 })).toBe(300);
    });
  });

  describe('integração com o FfmpegGraphBuilder', () => {
    const spec = (layers: RenderSpec['layers']): RenderSpec => ({
      format: 'mp4',
      width: 1080,
      height: 1920,
      fps: 24,
      durationMs: 8000,
      quality: 'standard',
      backgroundColor: 'ffffff',
      layers,
    });

    it('o builder aceita synced_clip e produz overlay de vídeo + adelay de áudio', () => {
      const { passes } = new FfmpegGraphBuilder().build(spec([clip()]), '/tmp/out.mp4');
      const filter = passes[0][passes[0].indexOf('-filter_complex') + 1];
      // adelay do áudio usa exatamente o startMs do clipe
      expect(filter).toContain('adelay=1000|1000');
      // e o overlay do vídeo abre no mesmo instante (1000ms = 1s)
      expect(filter).toContain("enable='between(t,1,8)'");
      expect(passes[0]).toContain('/uploads/mascote.webm');
      expect(passes[0]).toContain('/uploads/voz.mp3');
    });

    it('CONTRATO: qualquer startMs entra igual no overlay e no adelay', () => {
      for (const startMs of [0, 500, 2400, 7000]) {
        const { passes } = new FfmpegGraphBuilder().build(
          spec([clip({ startMs })]),
          '/tmp/out.mp4',
        );
        const filter = passes[0][passes[0].indexOf('-filter_complex') + 1];
        expect(filter).toContain(`adelay=${startMs}|${startMs}`);
        expect(filter).toContain(`enable='between(t,${startMs / 1000},`);
      }
    });

    it('vídeo do clipe entra com -stream_loop (idle em loop)', () => {
      const { passes } = new FfmpegGraphBuilder().build(spec([clip()]), '/tmp/out.mp4');
      expect(passes[0]).toContain('-stream_loop');
    });
  });
});
