import { FlyerProStructureLimiter } from './flyer-pro-structure-limiter';

const DOC = '2c1d7e9b-4f6a-4b1e-9a3d-7e5f0c8b6a21';
const OTHER = '9a0c4e12-77b3-4c5d-8e21-0f3a6b9d2c44';
const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** O limitador com um relógio que o teste move. */
function makeLimiter() {
  const clock = { now: 1_000_000 };
  const limiter = new FlyerProStructureLimiter(() => clock.now);
  return { limiter, clock };
}

describe('FlyerProStructureLimiter: uma sugestão em andamento por encarte', () => {
  it('a primeira vaga é dada, a segunda do mesmo encarte é recusada e a de outro encarte é aceita', () => {
    const { limiter } = makeLimiter();
    expect(limiter.tryAcquire(DOC, 25 * SECOND)).toBeNull();
    expect(limiter.tryAcquire(DOC, 25 * SECOND)).toEqual({
      reason: 'IN_FLIGHT',
      retryAfterSeconds: 25,
    });
    expect(limiter.tryAcquire(OTHER, 25 * SECOND)).toBeNull();
  });

  it('o retryAfterSeconds é o que falta até o prazo da chamada em andamento, arredondado para cima', () => {
    const { limiter, clock } = makeLimiter();
    limiter.tryAcquire(DOC, 25 * SECOND);
    clock.now += 1 * SECOND;
    expect(limiter.tryAcquire(DOC, 25 * SECOND)).toMatchObject({ retryAfterSeconds: 24 });
    clock.now += 500;
    expect(limiter.tryAcquire(DOC, 25 * SECOND)).toMatchObject({ retryAfterSeconds: 24 });
    clock.now += 22_900;
    expect(limiter.tryAcquire(DOC, 25 * SECOND)).toMatchObject({ retryAfterSeconds: 1 });
  });

  it('a vaga solta (sucesso, falha ou prazo) deixa o encarte livre, e soltar de novo não faz nada', () => {
    const { limiter } = makeLimiter();
    limiter.tryAcquire(DOC, 25 * SECOND);
    limiter.release(DOC);
    limiter.release(DOC);
    expect(limiter.tryAcquire(DOC, 25 * SECOND)).toBeNull();
  });

  it('soltar a vaga de um encarte não solta a de outro', () => {
    const { limiter } = makeLimiter();
    limiter.tryAcquire(DOC, 25 * SECOND);
    limiter.tryAcquire(OTHER, 25 * SECOND);
    limiter.release(DOC);
    expect(limiter.tryAcquire(OTHER, 25 * SECOND)).toMatchObject({ reason: 'IN_FLIGHT' });
  });

  it('vaga com o prazo vencido não segura o encarte', () => {
    const { limiter, clock } = makeLimiter();
    limiter.tryAcquire(DOC, 25 * SECOND);
    clock.now += 25 * SECOND;
    expect(limiter.tryAcquire(DOC, 25 * SECOND)).toBeNull();
  });

  it('uma instância nova começa do zero (a API reiniciou)', () => {
    const first = makeLimiter().limiter;
    first.tryAcquire(DOC, 25 * SECOND);
    expect(makeLimiter().limiter.tryAcquire(DOC, 25 * SECOND)).toBeNull();
  });
});

describe('FlyerProStructureLimiter: teto de sugestões atendidas por hora', () => {
  const serve = (limiter: FlyerProStructureLimiter, clock: { now: number }, times: number[]) => {
    const start = clock.now;
    for (const at of times) {
      clock.now = start + at;
      limiter.recordServed(DOC);
    }
    clock.now = start;
  };

  it('com 20 atendidas, a primeira há 41 minutos, o 21º pedido recebe HOURLY_LIMIT com 1140 s', () => {
    const { limiter, clock } = makeLimiter();
    // a primeira há 41 minutos e as outras 19 espalhadas depois dela, até agora
    serve(limiter, clock, [
      -41 * MINUTE,
      ...Array.from({ length: 19 }, (_, i) => -(30 - i) * MINUTE),
    ]);
    expect(limiter.checkHourly(DOC, 20)).toEqual({
      reason: 'HOURLY_LIMIT',
      retryAfterSeconds: 1140,
    });
  });

  it('com menos que o teto passa, e o teto é por encarte', () => {
    const { limiter, clock } = makeLimiter();
    serve(
      limiter,
      clock,
      Array.from({ length: 19 }, () => -10 * MINUTE),
    );
    expect(limiter.checkHourly(DOC, 20)).toBeNull();
    serve(limiter, clock, [-5 * MINUTE]);
    expect(limiter.checkHourly(DOC, 20)).toMatchObject({ reason: 'HOURLY_LIMIT' });
    expect(limiter.checkHourly(OTHER, 20)).toBeNull();
  });

  it('a sugestão que sai da janela de 60 minutos libera o pedido', () => {
    const { limiter, clock } = makeLimiter();
    serve(limiter, clock, [-30 * MINUTE, -20 * MINUTE]);
    expect(limiter.checkHourly(DOC, 2)).toEqual({
      reason: 'HOURLY_LIMIT',
      retryAfterSeconds: 1800,
    });
    clock.now += 30 * MINUTE - 1;
    expect(limiter.checkHourly(DOC, 2)).toMatchObject({ retryAfterSeconds: 1 });
    clock.now += 1;
    expect(limiter.checkHourly(DOC, 2)).toBeNull();
  });

  it('o teto é o que o chamador passa: com 3, a terceira atendida fecha', () => {
    const { limiter, clock } = makeLimiter();
    serve(limiter, clock, [-3 * MINUTE, -2 * MINUTE]);
    expect(limiter.checkHourly(DOC, 3)).toBeNull();
    serve(limiter, clock, [-1 * MINUTE]);
    expect(limiter.checkHourly(DOC, 3)).toMatchObject({
      reason: 'HOURLY_LIMIT',
      retryAfterSeconds: 3420,
    });
  });

  it('só recordServed conta: tomar e soltar a vaga, ou checar, não gasta o teto', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 30; i += 1) {
      limiter.tryAcquire(DOC, 25 * SECOND);
      limiter.checkHourly(DOC, 20);
      limiter.release(DOC);
    }
    expect(limiter.checkHourly(DOC, 20)).toBeNull();
  });

  it('uma instância nova começa do zero (a API reiniciou)', () => {
    const { limiter, clock } = makeLimiter();
    serve(limiter, clock, [-1 * MINUTE, -1 * MINUTE]);
    expect(limiter.checkHourly(DOC, 2)).not.toBeNull();
    expect(makeLimiter().limiter.checkHourly(DOC, 2)).toBeNull();
  });

  it('o encarte sem sugestão na última hora é esquecido na próxima gravação, sem afetar os demais', () => {
    const { limiter, clock } = makeLimiter();
    serve(limiter, clock, [-2 * 60 * MINUTE]);
    limiter.recordServed(OTHER);
    expect(limiter['served'].has(DOC)).toBe(false);
    expect(limiter.checkHourly(OTHER, 1)).toMatchObject({ reason: 'HOURLY_LIMIT' });
  });
});
