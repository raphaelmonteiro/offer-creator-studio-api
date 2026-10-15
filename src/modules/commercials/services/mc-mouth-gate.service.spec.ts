import {
  GeminiImageProvider,
  withGeminiBilling,
} from '../../../shared/providers/gemini-image.provider';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { decideMouthGate } from '../domain/mc-mouth-gate';
import { McMouthGateService } from './mc-mouth-gate.service';

describe('McMouthGateService — gate de boca (D4)', () => {
  const originalProvider = process.env.MC_KIT_PROVIDER;
  const originalMock = process.env.MC_MOUTH_GATE_MOCK;
  let gemini: { describeImagesWithUsage: jest.Mock };
  const vision = (text: string, usage: unknown = null) => ({
    text,
    model: 'gemini-3.8-flash',
    usage,
  });
  let service: McMouthGateService;

  beforeEach(() => {
    delete process.env.MC_KIT_PROVIDER;
    delete process.env.MC_MOUTH_GATE_MOCK;
    gemini = { describeImagesWithUsage: jest.fn() };
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
    expect(gemini.describeImagesWithUsage).not.toHaveBeenCalled();
    // mock não gasta: sem linha de custo
    expect((await service.inspectWithCost(Buffer.from('png'))).cost).toBeNull();
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
    gemini.describeImagesWithUsage.mockResolvedValue(
      vision(
        '{"has_mouth": true, "mouth_open_possible": false, "confidence": 0.88, "bbox": {"x": 0.2, "y": 0.1, "w": 0.6, "h": 0.5}}',
      ),
    );
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const verdict = await service.inspect(jpeg);
    expect(gemini.describeImagesWithUsage).toHaveBeenCalledWith(
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
    gemini.describeImagesWithUsage.mockRejectedValueOnce(new Error('HTTP 503'));
    const down = await service.inspectWithCost(Buffer.from('png'));
    expect(down.verdict).toMatchObject({ confidence: 0, bbox: null, error: 'HTTP 503' });
    expect(decideMouthGate(down.verdict)).toBe('undecided');
    expect(down.cost).toBeNull(); // sem resposta, sem cobrança
    expect(down.verdict.paid).toBeUndefined(); // re-inspecionável na aprovação

    gemini.describeImagesWithUsage.mockResolvedValueOnce(vision('não consigo avaliar'));
    const garbled = await service.inspect(Buffer.from('png'));
    expect(garbled.error).toMatch(/não interpretável/);
    expect(decideMouthGate(garbled)).toBe('undecided');
  });

  describe('custo da visão (tarefa 2.6)', () => {
    const usage = {
      promptTokens: 1200,
      candidatesTokens: 80,
      thoughtsTokens: 220,
      outputImageTokens: null,
      totalTokens: 1500,
    };

    it('resposta válida: linha de custo pelo modelo que respondeu (entrada + saída + raciocínio)', async () => {
      process.env.MC_KIT_PROVIDER = 'gemini';
      gemini.describeImagesWithUsage.mockResolvedValue(
        vision(
          '{"has_mouth": true, "mouth_open_possible": true, "confidence": 0.9, "bbox": null}',
          usage,
        ),
      );
      const { verdict, cost } = await service.inspectWithCost(Buffer.from('png'));
      expect(verdict.model).toBe('gemini-3.8-flash');
      expect(verdict).not.toHaveProperty('cost'); // o veredito gravado no kit não carrega custo
      expect(cost).toMatchObject({
        call: 'mouth_gate',
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        usage: { inputTokens: 1200, outputTokens: 300, images: 0 },
      });
      // 1200 × 0,50/1M + 300 × 3/1M = 0,0006 + 0,0009
      expect(cost?.costUsd).toBeCloseTo(0.0015, 6);
    });

    it('resposta ilegível também foi paga: veredito indeciso COM custo', async () => {
      process.env.MC_KIT_PROVIDER = 'gemini';
      gemini.describeImagesWithUsage.mockResolvedValue(vision('???', usage));
      const { verdict, cost } = await service.inspectWithCost(Buffer.from('png'));
      expect(decideMouthGate(verdict)).toBe('undecided');
      expect(cost?.costUsd).toBeCloseTo(0.0015, 6);
    });

    it('resposta ilegível sai com `paid: true` (reaproveitável na aprovação)', async () => {
      process.env.MC_KIT_PROVIDER = 'gemini';
      gemini.describeImagesWithUsage.mockResolvedValue(vision('???', usage));
      const { verdict } = await service.inspectWithCost(Buffer.from('png'));
      expect(verdict).toMatchObject({
        paid: true,
        error: expect.stringMatching(/não interpretável/),
      });
    });

    it('resposta 200 SEM texto (erro com cobrança anexada): indeciso, `paid`, com a linha de custo pelo uso devolvido', async () => {
      process.env.MC_KIT_PROVIDER = 'gemini';
      gemini.describeImagesWithUsage.mockRejectedValue(
        withGeminiBilling(
          new TerminalProviderError('Resposta sem texto', 'invalid_provider_output'),
          {
            model: 'gemini-3.8-flash',
            usage,
          },
        ),
      );
      const { verdict, cost } = await service.inspectWithCost(Buffer.from('png'));
      expect(decideMouthGate(verdict)).toBe('undecided');
      expect(verdict.paid).toBe(true);
      expect(cost).toMatchObject({
        call: 'mouth_gate',
        model: 'gemini-3.8-flash',
        failure: 'no_output',
        usage: { inputTokens: 1200, outputTokens: 300, images: 0 },
      });
      expect(cost?.costUsd).toBeCloseTo(0.0015, 6);
    });
  });
});
