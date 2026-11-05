import { findSceneFormat, SCENE_FORMATS } from '../domain/scene-formats';
import { nativeSizeOfFormat } from '../domain/scene-format-size';
import {
  buildEditPrompt,
  buildGeneratePrompt,
  buildGlobalPrompt,
  buildTransparentPrompt,
  CONTINUE_BACKGROUND,
  REMOVE_INSTRUCTION,
} from './scene-prompt';

const format = findSceneFormat('folheto-27x54')!;
const base = {
  request: 'campo verde com sol à direita',
  artWidthCm: format.artWidthCm,
  artHeightCm: format.artHeightCm,
  widthPx: 1920,
  heightPx: 3840,
};

/** Palavras de composição por faixas que nenhum prompt sem pedido do cliente pode trazer (D-16). */
const BANNED = [/cabeçalho/i, /miolo/i, /rodapé/i, /sem objetos/i, /\d+%/];

describe('Composição do prompt só a pedido do cliente: buildGeneratePrompt', () => {
  it('traz o pedido literal, o formato em cm, a proporção e o tamanho em px', () => {
    const prompt = buildGeneratePrompt(base);
    expect(prompt).toContain('"campo verde com sol à direita"');
    expect(prompt).toContain('27,5 x 55 cm');
    expect(prompt).toContain('proporção largura/altura 0,50');
    expect(prompt).toContain('1920 x 3840 px');
  });

  it('diz que a imagem é única e contínua, salvo pedido em contrário', () => {
    const prompt = buildGeneratePrompt(base);
    expect(prompt).toContain(
      'Salvo se o pedido acima disser outra coisa, a imagem é única e contínua, sem divisões, faixas ou molduras.',
    );
  });

  it('R31: a linha do formato não impõe "sem bordas nem molduras" antes da ressalva da D-16', () => {
    const prompt = buildGeneratePrompt({ ...base, request: 'pascoa com moldura dourada' });
    expect(prompt).not.toMatch(/sem bordas|bordas nem molduras/i);
    expect(prompt.match(/molduras/g)).toHaveLength(1);
    expect(prompt).toContain('ocupando toda a área.');
  });

  it('traz as regras fixas', () => {
    const prompt = buildGeneratePrompt(base);
    expect(prompt).toContain('sem texto legível');
    expect(prompt).toContain('sem logotipos');
    expect(prompt).toContain('sem preços');
  });

  it('Comparação lado a lado: a D-17 saiu, e o prompt sem pedido de composição não sugere menos detalhe no centro', () => {
    const prompt = buildGeneratePrompt(base);
    expect(prompt).not.toMatch(/menos detalhe|parte central|centro/i);
    expect(prompt.split('\n')).toHaveLength(5);
  });

  it('o cliente pode pedir divisão: o pedido vai literal e a regra só vale "salvo pedido"', () => {
    const request = 'divide a imagem em duas partes, azul em cima e verde embaixo';
    const prompt = buildGeneratePrompt({ ...base, request });
    expect(prompt).toContain(`"${request}"`);
    expect(prompt).toContain('Salvo se o pedido acima disser outra coisa');
  });

  it('mantém o pedido literal, com marcadores, e limpa controle e espaços', () => {
    const prompt = buildGeneratePrompt({ ...base, request: '  campo\n\n  verde \t #falha-quota ' });
    expect(prompt).toContain('"campo verde #falha-quota"');
  });

  describe.each(Object.keys(SCENE_FORMATS))('formato %s', (formatId) => {
    const spec = findSceneFormat(formatId)!;
    const size = nativeSizeOfFormat(spec)!;
    const prompt = buildGeneratePrompt({
      request: 'template de páscoa com ovos e um coelho',
      artWidthCm: spec.artWidthCm,
      artHeightCm: spec.artHeightCm,
      widthPx: size.width,
      heightPx: size.height,
    });

    it('traz o pedido, o formato, a imagem contínua e as regras fixas', () => {
      expect(prompt).toContain('template de páscoa com ovos e um coelho');
      expect(prompt).toContain(`${size.width} x ${size.height} px`);
      expect(prompt).toContain('única e contínua');
      expect(prompt).toContain('sem texto legível');
      expect(prompt).toContain('sem logotipos');
      expect(prompt).toContain('sem preços');
    });

    it('não traz porcentagem de zona, cabeçalho, miolo, rodapé nem "sem objetos"', () => {
      for (const banned of BANNED) expect(prompt).not.toMatch(banned);
    });
  });
});

describe('buildEditPrompt', () => {
  it('começa com "Na área marcada" e traz a instrução literal e a preservação do resto', () => {
    const prompt = buildEditPrompt({
      request: 'deixa o sol  mais\nalaranjado',
      remove: false,
      knownElements: [],
    });
    expect(prompt.startsWith('Na área marcada: deixa o sol mais alaranjado.')).toBe(true);
    expect(prompt).toContain('Altere somente a área indicada pela máscara');
    expect(prompt).toContain('Preserve todo o resto da imagem');
  });

  it('cita o nome dos elementos conhecidos na região', () => {
    const prompt = buildEditPrompt({
      request: 'mais brilho',
      remove: false,
      knownElements: ['Sol', 'Nuvem'],
    });
    expect(prompt.startsWith('Na área marcada (Sol, Nuvem): mais brilho.')).toBe(true);
  });

  it('Remover com objeto nomeado: a frase do cliente e a continuação do fundo', () => {
    const request =
      'ta a imagem ta melhor mas remove para mim da parte de baixo os ovos a direita.';
    const prompt = buildEditPrompt({
      request,
      remove: true,
      object: 'os ovos',
      knownElements: [],
    });
    expect(prompt).toContain(`Na área marcada: ${request}`);
    expect(prompt).toContain('Continue o fundo ao redor');
    expect(prompt).not.toContain(REMOVE_INSTRUCTION);
  });

  it('Remover com objeto nomeado: a área marcada citada no texto não troca a frase', () => {
    const prompt = buildEditPrompt({
      request: 'remova os ovos da area marcada',
      remove: true,
      object: 'os ovos',
      knownElements: [],
    });
    expect(prompt).toContain('remova os ovos da area marcada');
    expect(prompt).toContain(CONTINUE_BACKGROUND);
  });

  it.each(['remove isso', 'tira essa área', 'apaga o que está aqui'])(
    'Remover sem objeto nomeado (%s): pede para remover o que está na área e continuar o fundo',
    (request) => {
      const prompt = buildEditPrompt({ request, remove: true, object: null, knownElements: [] });
      expect(prompt).toContain(`Na área marcada: ${REMOVE_INSTRUCTION}.`);
    },
  );
});

describe('buildEditPrompt: regras fixas (correção 6)', () => {
  const edit = (request: string, remove = false) =>
    buildEditPrompt({ request, remove, knownElements: [] });

  it('Edição sem pedido de texto: sem texto legível, sem logotipos e sem preços', () => {
    const prompt = edit('deixa mais rústico');
    expect(prompt).toContain('sem texto legível');
    expect(prompt).toContain('sem letras ou números');
    expect(prompt).toContain('sem logotipos');
    expect(prompt).toContain('sem preços');
  });

  it('a remoção também leva as regras', () => {
    expect(edit('remova os ovos', true)).toContain('sem texto legível');
  });

  it('Texto exato: com "uma placa com letras", sai só a regra de texto', () => {
    const prompt = edit('desenha uma placa com letras');
    expect(prompt).not.toContain('sem texto legível');
    expect(prompt).not.toContain('sem letras');
    expect(prompt).toContain('sem logotipos');
    expect(prompt).toContain('sem preços');
  });

  it.each(['uma frase na placa', 'com palavras escritas', 'um texto na faixa'])(
    'pedido que fala em texto (%s) tira só a regra de texto',
    (request) => {
      expect(edit(request)).not.toContain('sem texto legível');
      expect(edit(request)).toContain('sem preços');
    },
  );
});

describe('buildGlobalPrompt e buildTransparentPrompt', () => {
  it('Prompt do ajuste geral: sem composição por faixas nem porcentagens de zona', () => {
    const prompt = buildGlobalPrompt({ request: 'deixa tudo mais quente' });
    expect(prompt).toContain('"deixa tudo mais quente"');
    expect(prompt).toContain('única e contínua');
    expect(prompt).toContain('sem texto legível');
    for (const banned of BANNED) expect(prompt).not.toMatch(banned);
  });

  it('o "adicionar" pede o item isolado com fundo transparente', () => {
    const prompt = buildTransparentPrompt('balão de ar quente');
    expect(prompt).toContain('balão de ar quente');
    expect(prompt).toContain('fundo totalmente transparente');
    expect(prompt).toContain('sem logotipos');
  });
});
