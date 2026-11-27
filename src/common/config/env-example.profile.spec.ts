import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_TEXT_MODEL,
} from '../../modules/ai/config/openai-models.config';
import { parseExample } from './env-example.guard.testutil';

/** Valores do perfil de produção (capability backend-env-profile): cada cenário lê a linha do `backend/.env.example`. */
const EXAMPLE_PATH = path.resolve(__dirname, '..', '..', '..', '.env.example');
const TEXT = fs.readFileSync(EXAMPLE_PATH, 'utf8');
const LINES = parseExample(TEXT);

const lineOf = (name: string) => {
  const found = LINES.filter((line) => line.name === name);
  if (found.length !== 1) throw new Error(`${name}: ${found.length} linhas no exemplo`);
  return found[0];
};

/** O texto dos comentários colados acima da linha (sem o `#`). */
function commentAbove(name: string): string {
  const rows = TEXT.split('\n');
  const comments: string[] = [];
  for (let i = lineOf(name).line - 2; i >= 0 && rows[i].startsWith('#'); i--)
    comments.unshift(rows[i]);
  return comments.join(' ');
}

describe('perfil de produção do .env.example', () => {
  it('Provedores reais no perfil, cada um com o custo no comentário', () => {
    const providers = {
      TEMPLATE_SCENE_IMAGE_PROVIDER: 'openai',
      FLYER_PRO_STRUCTURE_AI_PROVIDER: 'real',
      FLYER_PRO_ENRICH_PROVIDER: 'real',
      MC_SCRIPT_PROVIDER: 'openai',
      MC_KIT_PROVIDER: 'gemini',
      MC_PIPELINE_PROVIDER: 'real',
      MC_TRANSLATION_PROVIDER: 'openai',
    };
    Object.entries(providers).forEach(([name, value]) => {
      expect(lineOf(name)).toMatchObject({ value, commented: false });
      expect(commentAbove(name)).toMatch(/US\$|R\$|custo|Luna|Terra/);
    });
  });

  it('Funções ligadas no perfil, e o GC das cenas apaga de verdade', () => {
    const on = [
      'AI_SPELLCHECK_ENABLED',
      'AI_PRODUCT_CATEGORIZATION_ENABLED',
      'AI_NAME_PARSER_ENABLED',
      'AI_IMAGE_METADATA_ENABLED',
      'AI_GALLERY_EMBEDDING_ENABLED',
      'AI_FLYER_ASSEMBLY_ENABLED',
      'EAN_FLYER_RESOLVE_ENABLED',
      'TEMPLATE_SCENE_REFERENCE_ENABLED',
      'MC_ENABLED',
    ];
    on.forEach((name) => expect(lineOf(name)).toMatchObject({ value: 'true', commented: false }));
    expect(lineOf('TEMPLATE_SCENE_GC_DRY_RUN')).toMatchObject({ value: 'false', commented: false });
  });

  it('Comentário velho corrigido: o provedor real faz fotos, categorias e ortografia com OpenAI e DotCompany', () => {
    const comment = commentAbove('FLYER_PRO_ENRICH_PROVIDER');
    expect(comment).toMatch(/fotos/);
    expect(comment).toMatch(/categorias/);
    expect(comment).toMatch(/ortografia/);
    expect(comment).toMatch(/OpenAI/);
    expect(comment).toMatch(/DotCompany/);
    expect(TEXT).not.toMatch(/sem fase implementada/);
  });

  it('Modelo com padrão no código: linha comentada com o valor do código, que vale ao copiar o exemplo', () => {
    expect(lineOf('OPENAI_TEXT_MODEL')).toMatchObject({ commented: true, value: 'gpt-6-luna' });
    expect(lineOf('OPENAI_IMAGE_MODEL')).toMatchObject({
      commented: true,
      value: 'gpt-image-2.6-sunburst',
    });
    expect(lineOf('OPENAI_TEXT_MODEL').value).toBe(DEFAULT_TEXT_MODEL);
    expect(lineOf('OPENAI_IMAGE_MODEL').value).toBe(DEFAULT_IMAGE_MODEL);
  });

  it('Função desligada com motivo: MC_CHARACTER_CUTOUT vale false e o comentário diz o que falta para ligar', () => {
    expect(lineOf('MC_CHARACTER_CUTOUT')).toMatchObject({ value: 'false', commented: false });
    expect(commentAbove('MC_CHARACTER_CUTOUT')).toMatch(/calibra/);
    expect(commentAbove('MC_CHARACTER_CUTOUT')).toMatch(/ligar depois/);
  });

  it('Token de administração: vazio, e o comentário diz obrigatório, x-admin-token e valor longo e aleatório', () => {
    expect(lineOf('ADMIN_API_TOKEN')).toMatchObject({ value: '', commented: false });
    const comment = commentAbove('ADMIN_API_TOKEN');
    expect(comment).toMatch(/OBRIGAT/);
    expect(comment).toMatch(/x-admin-token/);
    expect(comment).toMatch(/LONGO e ALEAT/);
  });

  it('Linha dos créditos: as duas valem false e o comentário traz o motivo (402 INSUFFICIENT_CREDITS)', () => {
    ['AI_CREDITS_ENABLED', 'MC_CREDITS_ENABLED'].forEach((name) => {
      expect(lineOf(name)).toMatchObject({ value: 'false', commented: false });
    });
    expect(TEXT).toMatch(/Nenhuma rota concede saldo[\s\S]*402 INSUFFICIENT_CREDITS/);
  });

  it('Chamadas pagas por mensagem: 4, porque a refação do texto pintado precisa da quarta', () => {
    expect(lineOf('TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE').value).toBe('4');
    const comment = commentAbove('TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE');
    expect(comment).toMatch(/quarta/);
    expect(comment).toMatch(/segunda imagem sai sem juiz/);
  });

  it('Teto por hora da sugestão: 20, e acima disso a rota responde 429 HOURLY_LIMIT', () => {
    expect(lineOf('FLYER_PRO_STRUCTURE_AI_MAX_PER_HOUR').value).toBe('20');
    expect(commentAbove('FLYER_PRO_STRUCTURE_AI_MAX_PER_HOUR')).toMatch(/429 HOURLY_LIMIT/);
  });

  it('Compose local sobrepõe o perfil: o topo diz perfil de produção, mock, chaves zeradas e que fora do compose gasta crédito', () => {
    const top = TEXT.split('\n').slice(0, 20).join(' ');
    expect(top).toMatch(/PERFIL DE PRODU/);
    expect(top).toMatch(/docker-compose\.yml/);
    expect(top).toMatch(/mock/);
    expect(top).toMatch(/chaves[\s\S]*zeradas/);
    expect(top).toMatch(/GASTA crédito/);
  });

  it('Formatos novos de comerciais ligados só com o executor v2 que eles exigem (PV-16)', () => {
    expect(lineOf('MC_FORMATS').value).toBe('talking_art,offer_carousel,offer_piece');
    expect(lineOf('MC_PIPELINE_V2').value).toBe('all');
  });
});
