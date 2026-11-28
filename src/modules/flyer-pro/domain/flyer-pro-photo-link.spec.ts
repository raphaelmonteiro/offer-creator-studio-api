import { isGoogleGotoLink } from './flyer-pro-photo-link';

describe('isGoogleGotoLink: o link de redirecionamento do Google', () => {
  it.each([
    'https://www.google.com/goto?url=CAESYwHr',
    'https://google.com/goto?url=CAESYwHr',
    'http://www.google.com/goto?url=x',
  ])('%s é goto', (link) => {
    expect(isGoogleGotoLink(link)).toBe(true);
  });

  it.each([
    ['endereço direto de supermercado', 'https://www.extrabom.com.br/img/coxao-mole.jpg'],
    ['outro caminho do Google', 'https://www.google.com/imgres?imgurl=x'],
    ['host que só termina em google.com', 'https://notgoogle.com/goto?url=x'],
    ['google no caminho', 'https://exemplo.com/google.com/goto?url=x'],
    ['esquema data', 'data:image/png;base64,AAAA'],
    ['esquema ftp', 'ftp://www.google.com/goto?url=x'],
    ['texto que não é URL', 'goto'],
    ['vazio', ''],
  ])('%s não é goto', (_name, link) => {
    expect(isGoogleGotoLink(link)).toBe(false);
  });
});
