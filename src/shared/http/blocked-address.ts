import { BlockList, isIP } from 'node:net';

type Family = 'ipv4' | 'ipv6';

/** As faixas que o servidor nunca conecta (A-11 e D-orq-257 da change 47); documentação (192.0.2.0/24 e irmãs) fica de fora. */
const BLOCKED_RANGES: ReadonlyArray<readonly [string, number, Family]> = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  // Multicast e reservados, até 255.255.255.255.
  ['224.0.0.0', 3, 'ipv4'],
  // IPv6: "::" e "::1" (dentro de ::/96), IPv4 compatível, NAT64, local, Teredo, 6to4 e multicast.
  ['::', 96, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['fec0::', 10, 'ipv6'],
  ['2001::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
];

const blocked = new BlockList();
for (const [network, prefix, family] of BLOCKED_RANGES) blocked.addSubnet(network, prefix, family);

/** O endereço sem colchetes (host de URL IPv6) nem zona (`fe80::1%eth0`). */
export const bareAddress = (address: string): string =>
  address.replace(/^\[|\]$/g, '').split('%')[0];

/**
 * O endereço está nas faixas internas? O IPv4 mapeado em IPv6 (`::ffff:10.0.0.5` ou `::ffff:a00:5`) cai nas faixas do IPv4
 * (`BlockList` do Node). Texto que não é endereço vale como bloqueado: nunca se conecta a ele.
 */
export function isBlockedAddress(address: string): boolean {
  const host = bareAddress(address);
  const version = isIP(host);
  if (version === 0) return true;
  return blocked.check(host, version === 4 ? 'ipv4' : 'ipv6');
}
