import { QUEUES } from '../../../shared/queue/animation-queue.service';
import {
  isAllowedFalVideoUrl,
  MC_QUEUE_CONCURRENCY,
  MC_QUEUE_EXPIRE_S,
  mcExpireForQueue,
  mcPollBackoffS,
  mcQueueForStep,
} from './mc-pipeline.config';
import { McStepType } from './mc-types';

describe('mc-pipeline.config — filas, expiração e allowlist (plano §6.4/§6.8)', () => {
  it('roteia cada tipo de step para a fila certa', () => {
    expect(mcQueueForStep(McStepType.SCRIPT)).toBe(QUEUES.MC_LLM);
    expect(mcQueueForStep(McStepType.KEYFRAME)).toBe(QUEUES.MC_IMAGE);
    expect(mcQueueForStep(McStepType.TTS)).toBe(QUEUES.MC_TTS);
    expect(mcQueueForStep(McStepType.VIDEO)).toBe(QUEUES.MC_SUBMIT);
    expect(mcQueueForStep(McStepType.LIPSYNC)).toBe(QUEUES.MC_SUBMIT);
    expect(mcQueueForStep(McStepType.ASSEMBLY)).toBe(QUEUES.MC_FFMPEG);
  });

  it('concorrências do plano §6.4: tts 4, submit 8, poll 10, ingest 2, ffmpeg 1', () => {
    expect(MC_QUEUE_CONCURRENCY[QUEUES.MC_TTS]).toBe(4);
    expect(MC_QUEUE_CONCURRENCY[QUEUES.MC_SUBMIT]).toBe(8);
    expect(MC_QUEUE_CONCURRENCY[QUEUES.MC_POLL]).toBe(10);
    expect(MC_QUEUE_CONCURRENCY[QUEUES.MC_INGEST]).toBe(2);
    expect(MC_QUEUE_CONCURRENCY[QUEUES.MC_FFMPEG]).toBe(1);
  });

  it('expiração POR FILA: leves 120, ingest 300, ffmpeg 600', () => {
    expect(MC_QUEUE_EXPIRE_S[QUEUES.MC_TTS]).toBe(120);
    expect(MC_QUEUE_EXPIRE_S[QUEUES.MC_SUBMIT]).toBe(120);
    expect(MC_QUEUE_EXPIRE_S[QUEUES.MC_POLL]).toBe(120);
    expect(MC_QUEUE_EXPIRE_S[QUEUES.MC_INGEST]).toBe(300);
    expect(MC_QUEUE_EXPIRE_S[QUEUES.MC_FFMPEG]).toBe(600);
    expect(mcExpireForQueue(QUEUES.MC_FFMPEG)).toBe(600);
  });

  it('backoff do poll: 15/30/60 com cap', () => {
    expect(mcPollBackoffS(1)).toBe(15);
    expect(mcPollBackoffS(2)).toBe(30);
    expect(mcPollBackoffS(3)).toBe(60);
    expect(mcPollBackoffS(50)).toBe(60);
  });

  describe('allowlist do ingest (plano §6.8 — hostname parseado, https obrigatório)', () => {
    it('aceita fal.media, *.fal.media e *.fal.run em https', () => {
      expect(isAllowedFalVideoUrl('https://fal.media/files/abc/video.mp4')).toBe(true);
      expect(isAllowedFalVideoUrl('https://v3.fal.media/files/abc/video.mp4')).toBe(true);
      expect(isAllowedFalVideoUrl('https://queue.fal.run/model/requests/1')).toBe(true);
      expect(isAllowedFalVideoUrl('https://cdn.fal.run/out.mp4')).toBe(true);
    });

    it('rejeita http:// mesmo em host permitido', () => {
      expect(isAllowedFalVideoUrl('http://fal.media/files/abc/video.mp4')).toBe(false);
      expect(isAllowedFalVideoUrl('http://v3.fal.run/out.mp4')).toBe(false);
    });

    it('rejeita hosts fora da allowlist', () => {
      expect(isAllowedFalVideoUrl('https://evil.com/video.mp4')).toBe(false);
      expect(isAllowedFalVideoUrl('https://storage.googleapis.com/x.mp4')).toBe(false);
    });

    it('rejeita sufixo forjado (fal.media.evil.com) e prefixo (notfal.media)', () => {
      expect(isAllowedFalVideoUrl('https://fal.media.evil.com/video.mp4')).toBe(false);
      expect(isAllowedFalVideoUrl('https://notfal.media/video.mp4')).toBe(false);
      expect(isAllowedFalVideoUrl('https://fal.run.evil.com/video.mp4')).toBe(false);
    });

    it('rejeita bare fal.run (só subdomínios *.fal.run entram)', () => {
      expect(isAllowedFalVideoUrl('https://fal.run/video.mp4')).toBe(false);
    });

    it('rejeita lixo não-URL e schemes exóticos', () => {
      expect(isAllowedFalVideoUrl('not a url')).toBe(false);
      expect(isAllowedFalVideoUrl('file:///etc/passwd')).toBe(false);
      expect(isAllowedFalVideoUrl('ftp://fal.media/x.mp4')).toBe(false);
    });
  });
});
