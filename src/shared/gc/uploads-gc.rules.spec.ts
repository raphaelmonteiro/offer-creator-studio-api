import {
  EXPORT_RETENTION_MS,
  GcAssetCandidate,
  SOFT_DELETED_RETENTION_MS,
  selectGarbage,
} from './uploads-gc.rules';

const NOW = new Date('2026-08-17T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

const asset = (overrides: Partial<GcAssetCandidate> = {}): GcAssetCandidate => ({
  id: 'a1',
  kind: 'mascot_video',
  createdAt: daysAgo(1),
  deletedAt: null,
  fileUrl: '/uploads/animations/u1/t1/output.mp4',
  alphaUrl: null,
  posterUrl: null,
  thumbUrl: null,
  ...overrides,
});

describe('selectGarbage — regras do GC de uploads (TDD ADR-05)', () => {
  it('seleciona asset soft-deletado há mais de 7 dias, com todos os arquivos', () => {
    const result = selectGarbage(
      [
        asset({
          deletedAt: daysAgo(8),
          alphaUrl: '/uploads/animations/u1/t1/alpha.webm',
          thumbUrl: '/uploads/animations/u1/t1/thumb.jpg',
        }),
      ],
      NOW,
    );
    expect(result).toEqual([
      {
        assetId: 'a1',
        reason: 'soft_deleted_expired',
        files: [
          '/uploads/animations/u1/t1/output.mp4',
          '/uploads/animations/u1/t1/alpha.webm',
          '/uploads/animations/u1/t1/thumb.jpg',
        ],
      },
    ]);
  });

  it('NÃO seleciona soft-deletado dentro da retenção de 7 dias', () => {
    expect(selectGarbage([asset({ deletedAt: daysAgo(3) })], NOW)).toEqual([]);
  });

  it('fronteira: exatamente 7 dias não expira (precisa ser MAIS antigo)', () => {
    const exactly = new Date(NOW.getTime() - SOFT_DELETED_RETENTION_MS);
    expect(selectGarbage([asset({ deletedAt: exactly })], NOW)).toEqual([]);
  });

  it('seleciona export vivo com mais de 30 dias', () => {
    const result = selectGarbage(
      [
        asset({
          kind: 'export',
          createdAt: daysAgo(31),
          fileUrl: '/uploads/animations/u1/exports/r1.mp4',
        }),
      ],
      NOW,
    );
    expect(result).toEqual([
      {
        assetId: 'a1',
        reason: 'export_expired',
        files: ['/uploads/animations/u1/exports/r1.mp4'],
      },
    ]);
  });

  it('NÃO seleciona export recente nem export exatamente no limite de 30 dias', () => {
    expect(selectGarbage([asset({ kind: 'export', createdAt: daysAgo(10) })], NOW)).toEqual([]);
    const exactly = new Date(NOW.getTime() - EXPORT_RETENTION_MS);
    expect(selectGarbage([asset({ kind: 'export', createdAt: exactly })], NOW)).toEqual([]);
  });

  it('export soft-deletado há pouco mas antigo cai pela regra de export', () => {
    const result = selectGarbage(
      [asset({ kind: 'export', createdAt: daysAgo(60), deletedAt: daysAgo(2) })],
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('export_expired');
  });

  it('asset vivo que não é export NUNCA é selecionado, por mais antigo que seja', () => {
    expect(selectGarbage([asset({ createdAt: daysAgo(365) })], NOW)).toEqual([]);
  });

  it('filtra arquivos fora de /uploads/animations/ (não toca em outros domínios)', () => {
    const result = selectGarbage(
      [
        asset({
          deletedAt: daysAgo(10),
          fileUrl: '/uploads/gallery/imagem.png', // fora do escopo do GC
          posterUrl: '/uploads/animations/u1/t1/poster.jpg',
        }),
      ],
      NOW,
    );
    expect(result).toEqual([
      {
        assetId: 'a1',
        reason: 'soft_deleted_expired',
        files: ['/uploads/animations/u1/t1/poster.jpg'],
      },
    ]);
  });

  it('asset expirado sem nenhum arquivo elegível é omitido da seleção', () => {
    expect(selectGarbage([asset({ deletedAt: daysAgo(10), fileUrl: null })], NOW)).toEqual([]);
  });
});
