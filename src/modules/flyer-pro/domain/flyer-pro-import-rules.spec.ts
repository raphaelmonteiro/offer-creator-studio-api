import { importIssues } from './flyer-pro-import-rules';

describe('importIssues: coerência das contagens', () => {
  it('mais aceitas que lidas é COUNT_MISMATCH', () => {
    expect(importIssues({ rowCount: 5, acceptedCount: 6 })).toEqual([
      { field: 'acceptedCount', code: 'COUNT_MISMATCH' },
    ]);
  });

  it('nenhuma aceita é EMPTY, também quando nenhuma linha foi lida', () => {
    expect(importIssues({ rowCount: 5, acceptedCount: 0 })).toEqual([
      { field: 'acceptedCount', code: 'EMPTY' },
    ]);
    expect(importIssues({ rowCount: 0, acceptedCount: 0 })).toEqual([
      { field: 'acceptedCount', code: 'EMPTY' },
    ]);
  });

  it.each([
    [5, 4],
    [5, 5],
    [300, 50],
    [2147483647, 1],
  ])('%i lidas e %i aceitas não dão problema', (rowCount, acceptedCount) => {
    expect(importIssues({ rowCount, acceptedCount })).toEqual([]);
  });

  it('não compara com as recusadas: 300 lidas, 50 aceitas e 200 recusadas passam (250 recusadas de fato)', () => {
    expect(importIssues({ rowCount: 300, acceptedCount: 50 })).toEqual([]);
  });
});
