import { Brackets, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import {
  applyVoiceVisibility,
  applyVoiceVisibilityToQuery,
  voiceVisibilityWhere,
  voiceVisibleTo,
} from './voice-visibility';

/** Builder falso: registra as cláusulas e resolve `Brackets` como o TypeORM faria. */
function fakeQueryBuilder(alias = 'voice') {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  const qb: Record<string, unknown> = { alias };
  const where = (cond: string | Brackets, p?: Record<string, unknown>) => {
    if (cond instanceof Brackets) {
      const inner: string[] = [];
      const sub = {
        where: (c: string, ip?: Record<string, unknown>) => {
          inner.push(c);
          Object.assign(params, ip);
          return sub;
        },
        orWhere: (c: string, ip?: Record<string, unknown>) => {
          inner.push(`OR ${c}`);
          Object.assign(params, ip);
          return sub;
        },
      };
      cond.whereFactory(sub as never);
      clauses.push(`(${inner.join(' ')})`);
    } else {
      clauses.push(cond);
      Object.assign(params, p);
    }
    return qb;
  };
  qb.andWhere = jest.fn(where);
  return { qb: qb as unknown as SelectQueryBuilder<ObjectLiteral>, clauses, params };
}

describe('voice-visibility — predicado único de vozes por tenant (D10)', () => {
  const curated = { enabled: true, curated: true, ownerUserId: null };
  const mine = { enabled: true, curated: false, ownerUserId: 'u1' };
  const theirs = { enabled: true, curated: false, ownerUserId: 'u2' };
  const orphan = { enabled: true, curated: false, ownerUserId: null };
  const disabledCurated = { enabled: false, curated: true, ownerUserId: null };
  const disabledMine = { enabled: false, curated: false, ownerUserId: 'u1' };

  describe('voiceVisibleTo (em memória)', () => {
    it('voz curada e habilitada é visível para qualquer usuário', () => {
      expect(voiceVisibleTo(curated, 'u1')).toBe(true);
      expect(voiceVisibleTo(curated, 'u2')).toBe(true);
    });

    it('voz com dono só é visível para o dono', () => {
      expect(voiceVisibleTo(mine, 'u1')).toBe(true);
      expect(voiceVisibleTo(theirs, 'u1')).toBe(false);
    });

    it('voz não curada sem dono (Voice Library, clone antigo) fica oculta para todos', () => {
      expect(voiceVisibleTo(orphan, 'u1')).toBe(false);
      expect(voiceVisibleTo(orphan, 'u2')).toBe(false);
    });

    it('voz desabilitada nunca aparece, nem curada nem para o dono', () => {
      expect(voiceVisibleTo(disabledCurated, 'u1')).toBe(false);
      expect(voiceVisibleTo(disabledMine, 'u1')).toBe(false);
    });

    it('sem userId (vazio/null/undefined) só o ramo curado vale — nunca casa dono null com null', () => {
      expect(voiceVisibleTo(curated, undefined)).toBe(true);
      expect(voiceVisibleTo(orphan, undefined)).toBe(false);
      expect(voiceVisibleTo(orphan, null)).toBe(false);
      expect(voiceVisibleTo(orphan, '')).toBe(false);
      expect(voiceVisibleTo(mine, '')).toBe(false);
    });
  });

  describe('voiceVisibilityWhere (find/findOne)', () => {
    it('sem filtro extra: duas alternativas (curada OU do dono), ambas com enabled: true', () => {
      expect(voiceVisibilityWhere('u1')).toEqual([
        { enabled: true, curated: true },
        { enabled: true, ownerUserId: 'u1' },
      ]);
    });

    it('distribui o filtro extra em cada alternativa (objeto único)', () => {
      expect(voiceVisibilityWhere('u1', { providerVoiceId: 'pv-1' })).toEqual([
        { providerVoiceId: 'pv-1', enabled: true, curated: true },
        { providerVoiceId: 'pv-1', enabled: true, ownerUserId: 'u1' },
      ]);
    });

    it('array de alternativas (OR do resolve por id/providerVoiceId) → 2 × N alternativas', () => {
      const out = voiceVisibilityWhere('u1', [{ id: 'row-1' }, { providerVoiceId: 'pv-1' }]);
      expect(out).toHaveLength(4);
      expect(out).toEqual(
        expect.arrayContaining([
          { id: 'row-1', enabled: true, curated: true },
          { id: 'row-1', enabled: true, ownerUserId: 'u1' },
          { providerVoiceId: 'pv-1', enabled: true, curated: true },
          { providerVoiceId: 'pv-1', enabled: true, ownerUserId: 'u1' },
        ]),
      );
    });

    it('REGRESSÃO: userId vazio NÃO emite o ramo do dono — {ownerUserId: undefined} abriria a tabela inteira no TypeORM', () => {
      for (const userId of [undefined, null, '']) {
        const out = voiceVisibilityWhere(userId);
        expect(out).toEqual([{ enabled: true, curated: true }]);
        expect(out.some((w) => 'ownerUserId' in w)).toBe(false);
      }
    });

    it('o filtro extra não consegue sobrescrever enabled/curated (a regra vence)', () => {
      const out = voiceVisibilityWhere('u1', { enabled: false, curated: false } as never);
      expect(out[0]).toMatchObject({ enabled: true, curated: true });
    });
  });

  describe('applyVoiceVisibilityToQuery (query builder)', () => {
    it('aplica enabled e (curated OR ownerUserId = :param) com o alias do builder', () => {
      const { qb, clauses, params } = fakeQueryBuilder('v');
      applyVoiceVisibilityToQuery(qb, 'u1');
      expect(clauses).toEqual([
        'v.enabled = true',
        '(v.curated = true OR v.ownerUserId = :voiceVisibilityUserId)',
      ]);
      expect(params).toEqual({ voiceVisibilityUserId: 'u1' });
    });

    it('alias explícito sobrepõe o do builder', () => {
      const { qb, clauses } = fakeQueryBuilder('v');
      applyVoiceVisibilityToQuery(qb, 'u1', 'voz');
      expect(clauses[0]).toBe('voz.enabled = true');
    });

    it('sem userId: só enabled e curated, sem parâmetro de dono', () => {
      const { qb, clauses, params } = fakeQueryBuilder('v');
      applyVoiceVisibilityToQuery(qb, undefined);
      expect(clauses).toEqual(['v.enabled = true', 'v.curated = true']);
      expect(params).toEqual({});
    });
  });

  describe('applyVoiceVisibility (entrada única)', () => {
    it('com query builder → aplica andWhere e devolve o próprio builder', () => {
      const { qb, clauses } = fakeQueryBuilder('v');
      const out = applyVoiceVisibility(qb, 'u1');
      expect(out).toBe(qb);
      expect(clauses).toHaveLength(2);
    });

    it('com where (objeto) → devolve o array de alternativas', () => {
      expect(applyVoiceVisibility({}, 'u1')).toEqual(voiceVisibilityWhere('u1'));
    });

    it('com where (array) → devolve 2 × N alternativas', () => {
      expect(applyVoiceVisibility([{ id: 'a' }, { id: 'b' }], 'u1')).toHaveLength(4);
    });
  });

  it('as três formas concordam sobre os mesmos cenários da spec', () => {
    const rows = [curated, mine, theirs, orphan, disabledCurated, disabledMine];
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
      Object.entries(where).every(([k, v]) => row[k] === v);
    const viaWhere = rows.filter((r) =>
      voiceVisibilityWhere('u1').some((w) => matches(r, w as Record<string, unknown>)),
    );
    const viaPredicate = rows.filter((r) => voiceVisibleTo(r, 'u1'));
    expect(viaWhere).toEqual([curated, mine]);
    expect(viaPredicate).toEqual([curated, mine]);
  });
});
