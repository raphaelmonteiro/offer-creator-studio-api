import { utcInstantOf } from './flyer-pro-instant';

describe('utcInstantOf', () => {
  it('o formato do cursor (Z, microssegundos) segue como veio', () => {
    expect(utcInstantOf('2026-11-14T13:05:40.412377Z')).toBe('2026-11-14T13:05:40.412377Z');
  });

  it('valor sem fuso é lido como UTC', () => {
    expect(utcInstantOf('2026-11-14T13:05:40')).toBe('2026-11-14T13:05:40Z');
    expect(utcInstantOf('2026-11-14T13:05')).toBe('2026-11-14T13:05Z');
    expect(utcInstantOf('2026-11-14T13:05:40.412377')).toBe('2026-11-14T13:05:40.412377Z');
  });

  it('só a data vira meia-noite UTC', () => {
    expect(utcInstantOf('2026-11-14')).toBe('2026-11-14T00:00:00Z');
  });

  it('fuso explícito é mantido, inclusive o da data com traço', () => {
    for (const value of [
      '2026-11-14T13:05:40-03:00',
      '2026-11-14T13:05:40+0000',
      '2026-11-14T13:05:40-03',
    ]) {
      expect(utcInstantOf(value)).toBe(value);
    }
  });
});
