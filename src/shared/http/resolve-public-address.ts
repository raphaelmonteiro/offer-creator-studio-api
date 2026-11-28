import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { bareAddress, isBlockedAddress } from './blocked-address';
import { SafeDownloadError } from './safe-download-error';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolve um nome em todos os seus endereços (injetável no teste: nenhum teste consulta DNS). */
export type NameLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemLookup: NameLookup = async (hostname) => {
  const found = await dns.lookup(hostname, { all: true, verbatim: true });
  return found.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

async function lookupAll(host: string, lookup: NameLookup): Promise<ResolvedAddress[]> {
  try {
    return await lookup(host);
  } catch {
    throw new SafeDownloadError('NETWORK', `nome não resolvido (${host})`);
  }
}

/**
 * Os endereços de um host de URL (nome ou endereço escrito), todos conferidos: basta um interno para recusar com
 * `PRIVATE_ADDRESS`, antes de qualquer conexão. O IPv4 vem antes do IPv6 (o Docker padrão não tem rota IPv6); quem conecta
 * usa só estes endereços, sem resolver o nome de novo.
 */
export async function resolvePublicAddresses(
  hostname: string,
  lookup: NameLookup = systemLookup,
): Promise<ResolvedAddress[]> {
  const host = bareAddress(hostname);
  const written = isIP(host);
  const found = written
    ? [{ address: host, family: written === 6 ? (6 as const) : (4 as const) }]
    : await lookupAll(host, lookup);
  if (found.length === 0) throw new SafeDownloadError('NETWORK', `nome sem endereço (${host})`);
  if (found.some(({ address }) => isBlockedAddress(address))) {
    throw new SafeDownloadError('PRIVATE_ADDRESS', `endereço interno recusado (${host})`);
  }
  return [
    ...found.filter(({ family }) => family === 4),
    ...found.filter(({ family }) => family === 6),
  ];
}
