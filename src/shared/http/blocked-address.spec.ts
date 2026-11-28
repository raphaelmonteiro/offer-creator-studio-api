import { isBlockedAddress } from './blocked-address';

const ipv4 = (n: number): string =>
  [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const asNumber = (address: string): number =>
  address.split('.').reduce((total, part) => total * 256 + Number(part), 0);

/** Cada faixa IPv4 bloqueada (A-11): o primeiro e o último endereço dentro e o vizinho de fora de cada lado (quando existe). */
const IPV4_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/3',
];

function edgesOf(cidr: string) {
  const [network, prefix] = cidr.split('/');
  const first = asNumber(network);
  const size = 2 ** (32 - Number(prefix));
  const last = first + size - 1;
  return { first, last, before: first - 1, after: last + 1 };
}

const cases = IPV4_RANGES.flatMap((cidr) => {
  const { first, last, before, after } = edgesOf(cidr);
  const rows: Array<[string, string, boolean]> = [
    [`${cidr} primeiro`, ipv4(first), true],
    [`${cidr} último`, ipv4(last), true],
  ];
  if (before >= 0) rows.push([`${cidr} vizinho de baixo`, ipv4(before), false]);
  if (after <= 0xffffffff) rows.push([`${cidr} vizinho de cima`, ipv4(after), false]);
  return rows;
});

describe('isBlockedAddress: IPv4', () => {
  it.each(cases)('%s (%s)', (_label, address, expected) => {
    expect(isBlockedAddress(address)).toBe(expected);
  });

  it.each(['203.0.113.7', '192.0.2.10', '198.51.100.20', '8.8.8.8', '1.1.1.1'])(
    'endereço público e as faixas de documentação seguem liberados (%s)',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('isBlockedAddress: IPv4 mapeado em IPv6', () => {
  const mapped = IPV4_RANGES.flatMap((cidr) => {
    const { first, last, before, after } = edgesOf(cidr);
    const rows: Array<[string, string, boolean]> = [
      [`${cidr} primeiro`, `::ffff:${ipv4(first)}`, true],
      [`${cidr} último`, `::ffff:${ipv4(last)}`, true],
    ];
    if (before >= 0) rows.push([`${cidr} vizinho de baixo`, `::ffff:${ipv4(before)}`, false]);
    if (after <= 0xffffffff) rows.push([`${cidr} vizinho de cima`, `::ffff:${ipv4(after)}`, false]);
    return rows;
  });

  it.each(mapped)('%s (%s)', (_label, address, expected) => {
    expect(isBlockedAddress(address)).toBe(expected);
  });

  it.each([
    ['::ffff:a00:5', true],
    ['0:0:0:0:0:ffff:a00:5', true],
    ['::ffff:7f00:1', true],
    ['::ffff:cb00:7107', false],
    ['::ffff:203.0.113.7', false],
  ])('escrito em hexadecimal ou por extenso: %s', (address, expected) => {
    expect(isBlockedAddress(address)).toBe(expected);
  });
});

describe('isBlockedAddress: IPv6', () => {
  const rows: Array<[range: string, address: string, expected: boolean]> = [
    ['::', '::', true],
    ['::1', '::1', true],
    ['::/96 último', '::ffff:ffff', true],
    ['::/96 vizinho de cima', '::1:0:0', false],
    ['64:ff9b::/96 primeiro', '64:ff9b::', true],
    ['64:ff9b::/96 último', '64:ff9b::ffff:ffff', true],
    ['64:ff9b::/96 NAT64 com 10.0.0.5', '64:ff9b::a00:5', true],
    ['64:ff9b::/96 vizinho de cima', '64:ff9b::1:0:0', false],
    ['64:ff9b::/96 vizinho de baixo', '64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff', false],
    ['64:ff9b:1::/48 primeiro', '64:ff9b:1::', true],
    ['64:ff9b:1::/48 último', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff', true],
    ['64:ff9b:1::/48 vizinho de cima', '64:ff9b:2::', false],
    ['64:ff9b:1::/48 vizinho de baixo', '64:ff9b:0:ffff:ffff:ffff:ffff:ffff', false],
    ['fc00::/7 primeiro', 'fc00::', true],
    ['fc00::/7 último', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true],
    ['fc00::/7 vizinho de baixo', 'fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false],
    ['fc00::/7 vizinho de cima', 'fe00::', false],
    ['fe80::/10 primeiro', 'fe80::', true],
    ['fe80::/10 último', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true],
    ['fe80::/10 vizinho de baixo', 'fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false],
    ['fec0::/10 primeiro', 'fec0::', true],
    ['fec0::/10 último', 'feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true],
    ['2001::/32 primeiro (Teredo)', '2001::', true],
    ['2001::/32 último', '2001:0:ffff:ffff:ffff:ffff:ffff:ffff', true],
    ['2001::/32 Teredo com IPv4 embutido', '2001:0:4136:e378:8000:63bf:3fff:fdd2', true],
    ['2001::/32 vizinho de cima', '2001:1::', false],
    ['2001::/32 vizinho de baixo', '2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false],
    ['2002::/16 primeiro (6to4)', '2002::', true],
    ['2002::/16 último', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true],
    ['2002::/16 6to4 com 10.0.0.5', '2002:a00:5::1', true],
    ['2002::/16 vizinho de cima', '2003::', false],
    ['2002::/16 vizinho de baixo', '2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false],
    ['ff00::/8 primeiro', 'ff00::', true],
    ['ff00::/8 multicast', 'ff02::1', true],
    ['ff00::/8 último', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true],
    ['público', '2606:4700:4700::1111', false],
    ['público do Google', '2001:4860:4860::8888', false],
  ];

  it.each(rows)('%s (%s)', (_range, address, expected) => {
    expect(isBlockedAddress(address)).toBe(expected);
  });

  it('o host de URL vem entre colchetes e a zona não conta: os dois são tirados antes da conferência', () => {
    expect(isBlockedAddress('[::1]')).toBe(true);
    expect(isBlockedAddress('[::ffff:10.0.0.5]')).toBe(true);
    expect(isBlockedAddress('fe80::1%eth0')).toBe(true);
    expect(isBlockedAddress('[2606:4700:4700::1111]')).toBe(false);
  });
});

describe('isBlockedAddress: texto que não é endereço', () => {
  it.each(['', 'localhost', 'exemplo.com', '300.1.1.1', '10.0.0'])(
    'vale como bloqueado, porque nunca se conecta a ele (%p)',
    (text) => {
      expect(isBlockedAddress(text)).toBe(true);
    },
  );
});
