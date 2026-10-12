import { GeminiImageProvider } from '../../../shared/providers/gemini-image.provider';
import { decideMouthGate } from '../domain/mc-mouth-gate';
import { McMouthGateService } from './mc-mouth-gate.service';

describe('McMouthGateService — gate de boca (D4)', () => {
  const originalProvider = process.env.MC_KIT_PROVIDER;
  const originalMock = process.env.MC_MOUTH_GATE_MOCK;
  let gemini: { describeImages: jest.Mock };
  let service: McMouthGateService;

  beforeEach(() => {
    delete process.env.MC_KIT_PROVIDER;
    delete process.env.MC_MOUTH_GATE_MOCK;
    gemini = { describeImages: jest.fn() };
    service = new McMouthGateService(gemini as unknown as GeminiImageProvider);
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.MC_KIT_PROVIDER;
    else process.env.MC_KIT_PROVIDER = originalProvider;
    if (originalMock === undefined) delete process.env.MC_MOUTH_GATE_MOCK;
    else process.env.MC_MOUTH_GATE_MOCK = originalMock;
  });

  it('provider mock (default): veredito sintético "passed" com caixa, sem tocar a visão', async () => {
    const verdict = await service.inspect(Buffer.from('png'));
    expect(verdict).toMatchObject({ mock: true, model: 'mock', hasMouth: true });
    expect(verdict.bbox).toEqual({ x: 0.3, y: 0.15, w: 0.4, h: 0.4 });
    expect(decideMouthGate(verdict)).toBe('passed');
    expect(gemini.describeImages).not.toHaveBeenCalled();
  });

  it('MC_MOUTH_GATE_MOCK escolhe o cenário (blocked | undecided) para testes e e2e', async () => {
    process.env.MC_MOUTH_GATE_MOCK = 'blocked';
    expect(decideMouthGate(await service.inspect(Buffer.from('png')))).toBe('blocked');
    process.env.MC_MOUTH_GATE_MOCK = 'undecided';
    expect(decideMouthGate(await service.inspect(Buffer.from('png')))).toBe('undecided');
    process.env.MC_MOUTH_GATE_MOCK = 'qualquer-coisa';
    expect(decideMouthGate(await service.inspect(Buffer.from('png')))).toBe('passed');
  });

  it('gemini: manda a imagem com o MIME detectado e interpreta o JSON do contrato', async () => {
    process.env.MC_KIT_PROVIDER = 'gemini';
    gemini.describeImages.mockResolvedValue(
      '{"has_mouth": true, "mouth_open_possible": false, "confidence": 0.88, "bbox": {"x": 0.2, "y": 0.1, "w": 0.6, "h": 0.5}}',
    );
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const verdict = await service.inspect(jpeg);
    expect(gemini.describeImages).toHaveBeenCalledWith(
      expect.objectContaining({ images: [jpeg], mimeType: 'image/jpeg' }),
    );
    expect(verdict).toMatchObject({
      hasMouth: true,
      mouthOpenPossible: false,
      confidence: 0.88,
      bbox: { x: 0.2, y: 0.1, w: 0.6, h: 0.5 },
    });
    expect(verdict.mock).toBeUndefined();
    expect(decideMouthGate(verdict)).toBe('blocked');
  });

  it('visão indisponível ou resposta ilegível → veredito indeciso com o motivo (nunca lança)', async () => {
    process.env.MC_KIT_PROVIDER = 'gemini';
    gemini.describeImages.mockRejectedValueOnce(new Error('HTTP 503'));
    const down = await service.inspect(Buffer.from('png'));
    expect(down).toMatchObject({ confidence: 0, bbox: null, error: 'HTTP 503' });
    expect(decideMouthGate(down)).toBe('undecided');

    gemini.describeImages.mockResolvedValueOnce('não consigo avaliar');
    const garbled = await service.inspect(Buffer.from('png'));
    expect(garbled.error).toMatch(/não interpretável/);
    expect(decideMouthGate(garbled)).toBe('undecided');
  });
});
