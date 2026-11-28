import { fakeLookup } from './pinned-fetch.testutil';
import { resolvePublicAddresses } from './resolve-public-address';
import { SafeDownloadError } from './safe-download-error';

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as SafeDownloadError;
  }
  throw new Error('não recusou');
};

describe('resolvePublicAddresses', () => {
  it('nome público: devolve o endereço conferido', async () => {
    const lookup = fakeLookup({ 'www.extrabom.com.br': ['203.0.113.7'] });

    expect(await resolvePublicAddresses('www.extrabom.com.br', lookup)).toEqual([
      { address: '203.0.113.7', family: 4 },
    ]);
  });

  it('Nome de serviço da rede do compose: 172.18.x.x é recusado com PRIVATE_ADDRESS', async () => {
    const lookup = fakeLookup({ chroma_x_postgres: ['172.18.0.2'] });

    const error = await rejection(resolvePublicAddresses('chroma_x_postgres', lookup));

    expect(error).toMatchObject({ name: 'SafeDownloadError', reason: 'PRIVATE_ADDRESS' });
  });

  it('Nome público que resolve para rede privada: PRIVATE_ADDRESS', async () => {
    const lookup = fakeLookup({ 'fotos.exemplo.com': ['192.168.0.10'] });

    expect(await rejection(resolvePublicAddresses('fotos.exemplo.com', lookup))).toMatchObject({
      reason: 'PRIVATE_ADDRESS',
    });
  });

  it('Um endereço público e um privado: basta um para recusar', async () => {
    const lookup = fakeLookup({ 'cdn.exemplo.com': ['203.0.113.7', '10.0.0.5'] });

    expect(await rejection(resolvePublicAddresses('cdn.exemplo.com', lookup))).toMatchObject({
      reason: 'PRIVATE_ADDRESS',
    });
  });

  it('Nome que resolve para uma faixa do IPv6 que embute IPv4 (NAT64): PRIVATE_ADDRESS', async () => {
    const lookup = fakeLookup({ 'fotos.exemplo.com': ['64:ff9b::a00:5'] });

    expect(await rejection(resolvePublicAddresses('fotos.exemplo.com', lookup))).toMatchObject({
      reason: 'PRIVATE_ADDRESS',
    });
  });

  it.each([
    '169.254.169.254',
    '127.0.0.1',
    '[::1]',
    '[::ffff:10.0.0.5]',
    '[::10.0.0.5]',
    '[ff02::1]',
  ])('endereço escrito na URL (%s): recusado sem consultar o DNS', async (host) => {
    const lookup = fakeLookup({});

    expect(await rejection(resolvePublicAddresses(host, lookup))).toMatchObject({
      reason: 'PRIVATE_ADDRESS',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('endereço público escrito na URL passa sem consultar o DNS, sem os colchetes', async () => {
    const lookup = fakeLookup({});

    expect(await resolvePublicAddresses('[2606:4700:4700::1111]', lookup)).toEqual([
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('Faixas de documentação seguem públicas: 192.0.2.10, 198.51.100.20 e 203.0.113.7 passam', async () => {
    const lookup = fakeLookup({
      'fotos.exemplo.com': ['192.0.2.10', '198.51.100.20', '203.0.113.7'],
    });

    const found = await resolvePublicAddresses('fotos.exemplo.com', lookup);

    expect(found.map(({ address }) => address)).toEqual([
      '192.0.2.10',
      '198.51.100.20',
      '203.0.113.7',
    ]);
  });

  it('o IPv4 vem antes do IPv6, qualquer que seja a ordem da resposta', async () => {
    const lookup = fakeLookup({
      'cdn.exemplo.com': ['2606:4700::1', '203.0.113.7', '198.51.100.20'],
    });

    const found = await resolvePublicAddresses('cdn.exemplo.com', lookup);

    expect(found.map(({ address }) => address)).toEqual([
      '203.0.113.7',
      '198.51.100.20',
      '2606:4700::1',
    ]);
  });

  it('nome que não resolve ou sem endereço: NETWORK', async () => {
    const lookup = fakeLookup({ vazio: [] });

    expect(await rejection(resolvePublicAddresses('nao-existe.exemplo.com', lookup))).toMatchObject(
      {
        reason: 'NETWORK',
      },
    );
    expect(await rejection(resolvePublicAddresses('vazio', lookup))).toMatchObject({
      reason: 'NETWORK',
    });
  });
});
