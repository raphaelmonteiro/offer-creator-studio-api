import { HourlyWindow } from './flyer-pro-hourly-window';

const DOC = '2c1d7e9b-4f6a-4b1e-9a3d-7e5f0c8b6a21';
const OTHER = '9a0c4e12-77b3-4c5d-8e21-0f3a6b9d2c44';
const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Conta `times` instantes, o primeiro agora e os outros `gap` ms depois, deixando o relógio no último. */
function recordMany(window: HourlyWindow, key: string, times: number, gap = 0): void {
  for (let i = 0; i < times; i++) {
    if (i > 0) jest.advanceTimersByTime(gap);
    window.record(key);
  }
}

describe('HourlyWindow: a janela corrida de 60 minutos por chave', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-11-28T10:00:00Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('com menos instantes que o teto passa, e o teto é o que o chamador passa', () => {
    const window = new HourlyWindow();
    recordMany(window, DOC, 3);

    expect(window.check(DOC, 4)).toBeNull();
    expect(window.check(DOC, 3)).not.toBeNull();
    expect(window.check(DOC, 1)).not.toBeNull();
  });

  it('com 300 instantes, o mais antigo há 50 minutos, o próximo recebe 600 s', () => {
    const window = new HourlyWindow();
    window.record(DOC);
    jest.advanceTimersByTime(MINUTE);
    recordMany(window, DOC, 299);
    jest.advanceTimersByTime(49 * MINUTE);

    expect(window.check(DOC, 300)).toBe(600);
  });

  it('os segundos são arredondados para cima e nunca menos de 1', () => {
    const window = new HourlyWindow();
    window.record(DOC);
    jest.advanceTimersByTime(59 * MINUTE + 59_500);

    expect(window.check(DOC, 1)).toBe(1);
  });

  it('o instante que sai da janela libera a chave', () => {
    const window = new HourlyWindow();
    window.record(DOC);
    jest.advanceTimersByTime(60 * MINUTE - 1);
    expect(window.check(DOC, 1)).toBe(1);

    jest.advanceTimersByTime(1);

    expect(window.check(DOC, 1)).toBeNull();
  });

  it('cada chave tem a sua janela', () => {
    const window = new HourlyWindow();
    recordMany(window, DOC, 2);

    expect(window.check(DOC, 2)).not.toBeNull();
    expect(window.check(OTHER, 2)).toBeNull();
  });

  it('só record conta: olhar com check não gasta o teto', () => {
    const window = new HourlyWindow();

    for (let i = 0; i < 5; i++) window.check(DOC, 1);

    expect(window.check(DOC, 1)).toBeNull();
    expect(window.has(DOC)).toBe(false);
  });

  it('a chave sem instante na última hora é esquecida na próxima gravação, sem afetar as outras', () => {
    const window = new HourlyWindow();
    window.record(DOC);
    jest.advanceTimersByTime(2 * 60 * MINUTE);

    window.record(OTHER);

    expect(window.has(DOC)).toBe(false);
    expect(window.check(OTHER, 1)).not.toBeNull();
  });

  it('um relógio injetado vale no lugar do relógio do processo', () => {
    const clock = { now: 5_000_000 };
    const window = new HourlyWindow(() => clock.now);
    window.record(DOC);
    clock.now += 30 * MINUTE;

    expect(window.check(DOC, 1)).toBe(1800);
  });
});
