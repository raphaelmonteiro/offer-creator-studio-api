import { MockFlyerProPhotoSearch } from './flyer-pro-photo-search.mock';
import { createPhotoSearchPort } from './flyer-pro-photo-search.factory';
import { SerperPhotoSearch } from './flyer-pro-photo-search.serper';
import { configOf, TEST_SERPER_KEY } from './flyer-pro-photo-search.testutil';

describe('createPhotoSearchPort', () => {
  const warn = jest.fn();
  beforeEach(() => warn.mockReset());

  it('mock: o simulado, sem aviso, mesmo com a chave no ambiente', () => {
    const port = createPhotoSearchPort(
      { provider: 'mock', maxPerHour: 300 },
      configOf({ SERPER_API_KEY: TEST_SERPER_KEY }),
      { warn },
    );

    expect(port).toBeInstanceOf(MockFlyerProPhotoSearch);
    expect(warn).not.toHaveBeenCalled();
  });

  it('real com a chave: a Serper disponível, sem aviso', () => {
    const port = createPhotoSearchPort(
      { provider: 'real', maxPerHour: 300 },
      configOf({ SERPER_API_KEY: TEST_SERPER_KEY }),
      { warn },
    );

    expect(port).toBeInstanceOf(SerperPhotoSearch);
    expect(port.unavailableReason()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['ausente', {}],
    ['vazia', { SERPER_API_KEY: '' }],
    ['só espaços', { SERPER_API_KEY: '   ' }],
  ])('real com a chave %s: sobe, avisa uma vez sem valor e responde NO_API_KEY', (_name, env) => {
    const port = createPhotoSearchPort({ provider: 'real', maxPerHour: 300 }, configOf(env), {
      warn,
    });

    expect(port).toBeInstanceOf(SerperPhotoSearch);
    expect(port.unavailableReason()).toBe('NO_API_KEY');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('SERPER_API_KEY');
  });
});
