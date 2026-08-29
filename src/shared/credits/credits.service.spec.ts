import { EntityManager } from 'typeorm';
import { CreditsService, InsufficientCreditsError, creditsEnabled } from './credits.service';
import { AiCreditLedgerEntry } from './ai-credit-ledger.entity';

/**
 * Fake de EntityManager com ledger em memória — testa a lógica de
 * reserva total → consumo por etapa → estorno parcial (TDD §3.4)
 * incluindo a invariante SUM(delta) = -consumido.
 */
function fakeManager() {
  const rows: Array<{ userId: string; delta: number; reason: string; taskId: string | null }> = [];
  const manager = {
    rows,
    query: jest.fn().mockResolvedValue(undefined), // advisory lock → no-op
    insert: jest.fn((entity: unknown, row: (typeof rows)[0]) => {
      expect(entity).toBe(AiCreditLedgerEntry);
      rows.push(row);
      return Promise.resolve();
    }),
    count: jest.fn(
      (_entity: unknown, opts: { where: Array<{ taskId: string; reason: string }> }) => {
        const conditions = opts.where;
        return Promise.resolve(
          rows.filter((r) => conditions.some((c) => r.taskId === c.taskId && r.reason === c.reason))
            .length,
        );
      },
    ),
    createQueryBuilder: jest.fn(() => {
      let userId: string;
      const qb = {
        select: () => qb,
        where: (_sql: string, params: { userId: string }) => {
          userId = params.userId;
          return qb;
        },
        getRawOne: () =>
          Promise.resolve({
            balance: String(
              rows.filter((r) => r.userId === userId).reduce((s, r) => s + r.delta, 0),
            ),
          }),
      };
      return qb;
    }),
  };
  return manager as unknown as EntityManager & { rows: typeof rows };
}

describe('CreditsService (TDD §3.4)', () => {
  let service: CreditsService;
  let manager: ReturnType<typeof fakeManager>;

  beforeEach(() => {
    service = new CreditsService();
    manager = fakeManager();
  });

  it('reserva debita o total do pipeline quando há saldo', async () => {
    await service.grant(manager, 'u1', 100);
    await service.reserve(manager, 'u1', 't1', 32);
    expect(await service.getBalance(manager, 'u1')).toBe(68);
  });

  it('reserva com saldo insuficiente lança 402 sem gravar débito', async () => {
    await service.grant(manager, 'u1', 10);
    await expect(service.reserve(manager, 'u1', 't1', 32)).rejects.toThrow(
      InsufficientCreditsError,
    );
    expect(await service.getBalance(manager, 'u1')).toBe(10);
  });

  it('cenário do TDD: TTS sucede (2), vídeo falha → estorno parcial de 30', async () => {
    await service.grant(manager, 'u1', 100);
    await service.reserve(manager, 'u1', 't1', 32); // TTS 2 + vídeo 30
    // TTS concluiu → consumido = 2; vídeo falhou:
    const refunded = await service.refundUnconsumed(manager, 'u1', 't1', 32, 2);
    expect(refunded).toBe(30);
    // 100 (grant) - 32 (reserva) + 30 (estorno) = 98 → consumo final efetivo = 2
    expect(await service.getBalance(manager, 'u1')).toBe(98);
  });

  it('estorno parcial usa reason task_refund_partial; total usa task_refund', async () => {
    await service.grant(manager, 'u1', 100);
    await service.reserve(manager, 'u1', 't1', 32);
    await service.refundUnconsumed(manager, 'u1', 't1', 32, 2);
    expect(manager.rows.find((r) => r.reason === 'task_refund_partial')).toBeDefined();

    await service.reserve(manager, 'u1', 't2', 20);
    await service.refundUnconsumed(manager, 'u1', 't2', 20, 0);
    expect(manager.rows.find((r) => r.taskId === 't2' && r.reason === 'task_refund')).toBeDefined();
  });

  it('estorno é idempotente: segunda chamada vira no-op', async () => {
    await service.grant(manager, 'u1', 100);
    await service.reserve(manager, 'u1', 't1', 32);
    expect(await service.refundUnconsumed(manager, 'u1', 't1', 32, 2)).toBe(30);
    expect(await service.refundUnconsumed(manager, 'u1', 't1', 32, 2)).toBe(0);
    const refunds = manager.rows.filter((r) => r.taskId === 't1' && r.delta > 0);
    expect(refunds).toHaveLength(1);
  });

  it('invariante: SUM(delta) da task terminal = -consumido', async () => {
    await service.grant(manager, 'u1', 100);
    await service.reserve(manager, 'u1', 't1', 32);
    await service.refundUnconsumed(manager, 'u1', 't1', 32, 2);
    const taskSum = manager.rows.filter((r) => r.taskId === 't1').reduce((s, r) => s + r.delta, 0);
    expect(taskSum).toBe(-2);
  });

  it('reserva de 0 créditos (pipeline 100% cacheado) não grava linha', async () => {
    await service.reserve(manager, 'u1', 't1', 0);
    expect(manager.rows).toHaveLength(0);
  });

  describe('flags por família (AI_CREDITS_ENABLED / MC_CREDITS_ENABLED)', () => {
    const originalAi = process.env.AI_CREDITS_ENABLED;
    const originalMc = process.env.MC_CREDITS_ENABLED;
    afterEach(() => {
      if (originalAi === undefined) delete process.env.AI_CREDITS_ENABLED;
      else process.env.AI_CREDITS_ENABLED = originalAi;
      if (originalMc === undefined) delete process.env.MC_CREDITS_ENABLED;
      else process.env.MC_CREDITS_ENABLED = originalMc;
    });

    it('cobrança desligada por padrão nas duas famílias (uso livre)', () => {
      delete process.env.AI_CREDITS_ENABLED;
      delete process.env.MC_CREDITS_ENABLED;
      expect(creditsEnabled()).toBe(false);
      expect(creditsEnabled('animations')).toBe(false);
      expect(creditsEnabled('commercials')).toBe(false);
    });

    it('só liga com a string exata "true"', () => {
      process.env.AI_CREDITS_ENABLED = '1';
      expect(creditsEnabled()).toBe(false);
      process.env.AI_CREDITS_ENABLED = 'true';
      expect(creditsEnabled()).toBe(true);

      process.env.MC_CREDITS_ENABLED = '1';
      expect(creditsEnabled('commercials')).toBe(false);
      process.env.MC_CREDITS_ENABLED = 'true';
      expect(creditsEnabled('commercials')).toBe(true);
    });

    it('famílias são independentes (uma ligada não liga a outra)', () => {
      delete process.env.MC_CREDITS_ENABLED;
      process.env.AI_CREDITS_ENABLED = 'true';
      expect(creditsEnabled('animations')).toBe(true);
      expect(creditsEnabled('commercials')).toBe(false);

      delete process.env.AI_CREDITS_ENABLED;
      process.env.MC_CREDITS_ENABLED = 'true';
      expect(creditsEnabled('commercials')).toBe(true);
      expect(creditsEnabled('animations')).toBe(false);
      // default continua sendo a família animations (chamadores antigos intactos)
      expect(creditsEnabled()).toBe(false);
    });
  });
});
