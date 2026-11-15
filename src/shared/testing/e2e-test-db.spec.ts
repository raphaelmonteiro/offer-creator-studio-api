import { assertE2eDbUrl, e2eDbNameOf, E2E_DB_ENV, selectDescribe } from './e2e-test-db';

const BASE = 'postgres://usuario:senha@localhost:5434';

/** Roda no gate, sem banco: a recusa acontece antes de qualquer conexão. */
describe('Banco descartável do e2e: recusa e pulo (sem conexão)', () => {
  it.each([
    ['flyer_db', `${BASE}/flyer_db`],
    ['flyer_db com ?sslmode=disable', `${BASE}/flyer_db?sslmode=disable`],
    ['FLYER_DB em maiúsculas', `${BASE}/FLYER_DB`],
  ])('recusa o %s e a mensagem traz o nome recebido', (_label, url) => {
    const received = new URL(url).pathname.slice(1);
    expect(() => assertE2eDbUrl(url)).toThrow(/O e2e nunca usa o flyer_db/);
    expect(() => assertE2eDbUrl(url)).toThrow(new RegExp(`recebido: ${received}\\)`));
  });

  it.each(['chroma_x_tp_faces', 'chroma_x_realpass', 'postgres'])(
    'recusa o banco %s, que não termina em _e2e',
    (name) => {
      expect(() => assertE2eDbUrl(`${BASE}/${name}`)).toThrow(
        new RegExp(`só usa banco cujo nome termina em _e2e \\(recebido: ${name}\\)`),
      );
    },
  );

  it('recusa a URL sem nome de banco e cita o que recebeu', () => {
    expect(() => assertE2eDbUrl(`${BASE}`)).toThrow(/recebido: \(nenhum\)/);
    expect(() => assertE2eDbUrl(`${BASE}/`)).toThrow(/recebido: \(nenhum\)/);
  });

  it('não vaza a senha na mensagem da recusa', () => {
    let message = '';
    try {
      assertE2eDbUrl(`${BASE}/postgres`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('recebido: postgres');
    expect(message).not.toContain('senha');
    expect(message).not.toContain('usuario');
  });

  it('recusa uma URL que não é URL, nomeando a variável', () => {
    expect(() => assertE2eDbUrl('isto não é uma url')).toThrow(new RegExp(E2E_DB_ENV));
  });

  it('aceita o chroma_x_e2e, com parâmetros e em maiúsculas', () => {
    expect(assertE2eDbUrl(`${BASE}/chroma_x_e2e`).pathname).toBe('/chroma_x_e2e');
    expect(() => assertE2eDbUrl(`${BASE}/chroma_x_e2e?sslmode=disable`)).not.toThrow();
    expect(() => assertE2eDbUrl(`${BASE}/CHROMA_X_PW_E2E`)).not.toThrow();
  });

  it('lê o nome do banco sem os parâmetros e em minúsculas', () => {
    expect(e2eDbNameOf(`${BASE}/Chroma_X_E2E?sslmode=disable&x=1`)).toBe('chroma_x_e2e');
  });

  it('sem a variável, assertE2eDbUrl falha nomeando a variável', () => {
    expect(() => assertE2eDbUrl(undefined)).toThrow(new RegExp(`${E2E_DB_ENV} não definida`));
  });

  it('sem a variável, o seletor devolve o describe.skip; com ela, o describe', () => {
    expect(selectDescribe(undefined)).toBe(describe.skip);
    expect(selectDescribe('')).toBe(describe.skip);
    expect(selectDescribe(`${BASE}/chroma_x_e2e`)).toBe(describe);
  });
});
