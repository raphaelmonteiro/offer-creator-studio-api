/** Endereço público de teste dos arquivos da semente (o comando do e2e de navegador usa o `CDN_URL` do ambiente). */
export const E2E_CDN_URL = 'http://cdn.e2e.test/uploads';

/** Os identificadores de uma semente: e-mail, senha, CNPJs e nomes. A mesma semente roda com ids únicos ou fixos. */
export interface SeedIdentity {
  email: string;
  password: string;
  userName: string;
  clientWithLibrary: { name: string; cnpj: string };
  clientLegacyFooter: { name: string; cnpj: string };
  sceneFrontBack: string;
  sceneTabloid: string;
  folderName: string;
  photoFiles: [string, string];
}

/** Senha de teste: só vale em banco `_e2e` (a recusa do harness, D-3); fica no código por decisão do dono (D-1). */
export const E2E_PASSWORD = 'E2e-senha-123';

/**
 * Identificadores fixos do comando da semente para o e2e de navegador (D-1): o navegador entra com `e2e@chroma.local`
 * e acha os mesmos clientes, cenas e fotos a cada execução.
 */
export const FIXED_IDENTITY: SeedIdentity = {
  email: 'e2e@chroma.local',
  password: E2E_PASSWORD,
  userName: 'Usuária E2E',
  clientWithLibrary: { name: 'Cliente E2E Cabeçalho e Rodapé', cnpj: '11.111.111/0001-11' },
  clientLegacyFooter: { name: 'Cliente E2E Rodapé legado', cnpj: '22.222.222/0001-22' },
  sceneFrontBack: 'E2E Folheto 27x40',
  sceneTabloid: 'E2E Jornal 54x40',
  folderName: 'E2E Pasta',
  photoFiles: ['e2e-foto-1.png', 'e2e-foto-2.png'],
};

let counter = 0;

/** Identificadores únicos por execução (hora, processo e contador): duas suítes juntas e execuções repetidas não colidem. */
export function uniqueIdentity(): SeedIdentity {
  counter += 1;
  const suffix = `${Date.now().toString(36)}-${process.pid}-${counter}`;
  return {
    email: `e2e-${suffix}@example.com`,
    password: E2E_PASSWORD,
    userName: 'Usuária E2E',
    clientWithLibrary: { name: `Cliente E2E A ${suffix}`, cnpj: `e2e-${suffix}-a` },
    clientLegacyFooter: { name: `Cliente E2E B ${suffix}`, cnpj: `e2e-${suffix}-b` },
    sceneFrontBack: `E2E Folheto 27x40 ${suffix}`,
    sceneTabloid: `E2E Jornal 54x40 ${suffix}`,
    folderName: `E2E Pasta ${suffix}`,
    photoFiles: [`e2e-${suffix}-foto-1.png`, `e2e-${suffix}-foto-2.png`],
  };
}
