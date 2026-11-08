import {
  applyDirectorRequests,
  applyJudgeVerdict,
  BriefItem,
  openItems,
  supersedeAtTurnEnd,
  turnItems,
} from './scene-brief';
import { DirectorRequest } from './scene-director-schema';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const LATER = new Date('2026-11-07T12:00:00.000Z');
const ctx = (messageId = 'm1', now = NOW, message = 'um rio no meio do campo') => ({
  messageId,
  now,
  message,
});
const open = (text: string, id: string | null = null): DirectorRequest => ({
  id,
  text,
  action: 'open',
  quote: null,
});
const drop = (id: string | null, text: string, quote: string): DirectorRequest => ({
  id,
  text,
  action: 'drop',
  quote,
});

const RIO: BriefItem = {
  id: 'p1',
  text: 'um rio no meio do campo',
  status: 'open',
  sourceMessageId: 'm1',
  updatedAt: NOW.toISOString(),
};

describe('scene-brief', () => {
  describe('abrir', () => {
    it('pedido novo vira item aberto com id curto, mensagem de origem e data', () => {
      const { brief, changes } = applyDirectorRequests([], [open('um rio no meio')], ctx());
      expect(brief).toEqual([
        {
          id: 'p1',
          text: 'um rio no meio',
          status: 'open',
          sourceMessageId: 'm1',
          updatedAt: NOW.toISOString(),
        },
      ]);
      expect(changes).toEqual({
        opened: ['p1'],
        dropped: [],
        closed: [],
        reopened: [],
        superseded: [],
      });
    });

    it('Pedido com ano não fica em aberto: ano, data e número escrito não abrem item, e "tira o 2027" abre', () => {
      const { brief, changes } = applyDirectorRequests(
        [],
        [open('indicação do ano 2027'), open('a data 12/04'), open('tira o 2027 do ovo')],
        ctx(),
      );
      expect(brief.map((item) => item.text)).toEqual(['tira o 2027 do ovo']);
      expect(changes.opened).toEqual(['p1']);
    });

    it('Número que o cliente pediu para pintar abre o item (rodada 6, D-54)', () => {
      const message = 'tira o coelho e coloca uma placa com "Feliz 2027"';
      const { brief } = applyDirectorRequests(
        [],
        [open('placa com a frase Feliz 2027'), open('indicação do ano 2028')],
        ctx('m1', NOW, message),
      );
      expect(brief.map((item) => item.text)).toEqual(['placa com a frase Feliz 2027']);
    });

    it('R8: "rio" não casa com "cenário colorido": vira item novo, e o outro não muda', () => {
      const colorido: BriefItem = { ...RIO, id: 'p1', text: 'cenário colorido' };
      const { brief, changes } = applyDirectorRequests([colorido], [open('rio')], ctx());
      expect(brief.map((item) => [item.id, item.text, item.status])).toEqual([
        ['p1', 'cenário colorido', 'open'],
        ['p2', 'rio', 'open'],
      ]);
      expect(changes.opened).toEqual(['p2']);
    });

    it.each([
      ['sol', 'girassol amarelo'],
      ['flor', 'campo florido'],
    ])('R8: "%s" não casa com "%s"', (wanted, existing) => {
      const item: BriefItem = { ...RIO, text: existing };
      const { brief } = applyDirectorRequests([item], [open(wanted)], ctx());
      expect(brief).toHaveLength(2);
    });

    it('R8: palavra inteira casa, inclusive no plural ("rio" em "um rio largo", "coelhos" em "coelho")', () => {
      const item: BriefItem = { ...RIO, text: 'um rio largo' };
      expect(applyDirectorRequests([item], [open('rio')], ctx()).brief).toHaveLength(1);
      const coelho: BriefItem = { ...RIO, text: 'coelho' };
      expect(applyDirectorRequests([coelho], [open('coelhos')], ctx()).brief).toHaveLength(1);
    });

    it('os ids seguem a sequência, mesmo depois de itens feitos ou desistidos', () => {
      const done: BriefItem = { ...RIO, id: 'p3', status: 'done' };
      const { brief } = applyDirectorRequests([done], [open('mais ovos')], ctx('m2'));
      expect(brief.map((item) => item.id)).toEqual(['p3', 'p4']);
    });

    it('pedido repetido, com o mesmo texto, não duplica', () => {
      const { brief, changes } = applyDirectorRequests(
        [RIO],
        [open('Um RIO no meio do campo')],
        ctx('m2'),
      );
      expect(brief).toHaveLength(1);
      expect(changes.opened).toEqual([]);
    });

    it('cliente pede de novo um item feito ou desistido: reabre', () => {
      const done: BriefItem = { ...RIO, status: 'done' };
      const result = applyDirectorRequests([done], [open('rio', 'p1')], ctx('m2', LATER));
      expect(result.brief[0]).toMatchObject({
        status: 'open',
        sourceMessageId: 'm2',
        updatedAt: LATER.toISOString(),
      });
      expect(result.changes.reopened).toEqual(['p1']);
    });

    it('não altera a lista recebida', () => {
      const original = [RIO];
      applyDirectorRequests(original, [drop('p1', 'rio', 'esquece o rio')], ctx('m2'));
      expect(original[0].status).toBe('open');
    });
  });

  describe('reabrir (R10)', () => {
    const feito: BriefItem = { ...RIO, id: 'p1', text: 'coelho', status: 'done' };

    it('o Diretor não reabre item feito se a mensagem atual não fala dele', () => {
      const { brief, changes } = applyDirectorRequests(
        [feito],
        [open('coelho')],
        ctx('m2', NOW, 'deixa mais quente'),
      );
      expect(brief[0].status).toBe('done');
      expect(changes.reopened).toEqual([]);
    });

    it('o cliente pede de novo na mensagem atual: o item volta a aberto', () => {
      const { brief, changes } = applyDirectorRequests(
        [feito],
        [open('coelho')],
        ctx('m2', NOW, 'coloca outro coelho'),
      );
      expect(brief[0].status).toBe('open');
      expect(changes.reopened).toEqual(['p1']);
    });

    it('item desistido também só reabre se a mensagem atual fala dele', () => {
      const desistido: BriefItem = { ...feito, status: 'dropped' };
      expect(
        applyDirectorRequests([desistido], [open('coelho')], ctx('m2', NOW, 'mais flores')).brief[0]
          .status,
      ).toBe('dropped');
    });
  });

  describe('desistir', () => {
    it('drop por id', () => {
      const { brief, changes } = applyDirectorRequests(
        [RIO],
        [drop('p1', 'rio', 'esquece o rio')],
        ctx('m2'),
      );
      expect(brief[0].status).toBe('dropped');
      expect(changes.dropped).toEqual(['p1']);
    });

    it('drop sem id acha o item pelo texto contido', () => {
      const { brief } = applyDirectorRequests(
        [RIO],
        [drop(null, 'rio', 'esquece o rio')],
        ctx('m2'),
      );
      expect(brief[0].status).toBe('dropped');
    });

    it('Plural do item: "esquece as flores" desiste do item "flor", e "flor" não casa com "florido"', () => {
      const flor: BriefItem = { ...RIO, id: 'p1', text: 'flor' };
      const florido: BriefItem = { ...RIO, id: 'p2', text: 'campo florido' };
      const { brief } = applyDirectorRequests(
        [flor, florido],
        [drop(null, 'flores', 'esquece as flores')],
        ctx('m2', NOW, 'esquece as flores'),
      );
      expect(brief.map((item) => [item.id, item.status])).toEqual([
        ['p1', 'dropped'],
        ['p2', 'open'],
      ]);
    });

    it('R8: "esquece o rio" desiste do "um rio largo", e não do "cenário colorido"', () => {
      const colorido: BriefItem = { ...RIO, id: 'p1', text: 'cenário colorido' };
      const largo: BriefItem = { ...RIO, id: 'p2', text: 'um rio largo' };
      const { brief, changes } = applyDirectorRequests(
        [colorido, largo],
        [drop(null, 'rio', 'esquece o rio')],
        ctx('m2', NOW, 'esquece o rio'),
      );
      expect(brief.map((item) => [item.id, item.status])).toEqual([
        ['p1', 'open'],
        ['p2', 'dropped'],
      ]);
      expect(changes.dropped).toEqual(['p2']);
    });

    it('drop de item que não existe é ignorado', () => {
      const { brief, changes } = applyDirectorRequests(
        [RIO],
        [drop(null, 'borboleta', 'sem borboleta')],
        ctx('m2'),
      );
      expect(brief).toEqual([RIO]);
      expect(changes.dropped).toEqual([]);
    });
  });

  describe('item do turno (D-59)', () => {
    it('item aberto do turno anterior devolvido com o mesmo id passa a ser da mensagem atual', () => {
      const { brief, changes } = applyDirectorRequests(
        [RIO],
        [open('um rio no meio do campo', 'p1')],
        ctx('m2', LATER, 'sim, faz'),
      );
      expect(brief[0]).toMatchObject({ id: 'p1', status: 'open', sourceMessageId: 'm2' });
      expect(changes.opened).toEqual([]);
      expect(turnItems(brief, 'm2').map((item) => item.id)).toEqual(['p1']);
      expect(turnItems(brief, 'm1')).toEqual([]);
    });

    it('item que o Diretor não devolve continua da mensagem de origem', () => {
      const { brief } = applyDirectorRequests(
        [RIO],
        [open('um céu azul')],
        ctx('m2', LATER, 'céu'),
      );
      expect(brief.find((item) => item.id === 'p1')?.sourceMessageId).toBe('m1');
      expect(turnItems(brief, 'm2').map((item) => item.text)).toEqual(['um céu azul']);
    });
  });

  describe('juiz', () => {
    const verdict = (seen: string[], notSeen: string[]) => ({ seen, notSeen });

    it('só o juiz fecha: item do turno visto vira feito, e o que ele não viu continua aberto', () => {
      const second: BriefItem = { ...RIO, id: 'p2', text: 'ovos no rodapé' };
      const { brief, changes } = applyJudgeVerdict([RIO, second], verdict(['p1'], ['p2']), {
        messageId: 'm1',
        now: LATER,
      });
      expect(brief.map((item) => item.status)).toEqual(['done', 'open']);
      expect(changes.closed).toEqual(['p1']);
      expect(openItems(brief).map((item) => item.id)).toEqual(['p2']);
    });

    it('Item feito some da imagem: o juiz não reabre item feito', () => {
      const done: BriefItem = { ...RIO, status: 'done' };
      const { brief, changes } = applyJudgeVerdict([done], verdict([], ['p1']), {
        messageId: 'm2',
        now: LATER,
      });
      expect(brief).toEqual([done]);
      expect(changes.reopened).toEqual([]);
    });

    it('Item de turno anterior em nao_vistos ou vistos: id fora do turno é ignorado', () => {
      const { brief, changes } = applyJudgeVerdict([RIO], verdict(['p1'], ['p1']), {
        messageId: 'm2',
        now: LATER,
      });
      expect(brief).toEqual([RIO]);
      expect(changes.closed).toEqual([]);
    });

    it('ids desconhecidos e itens desistidos não mudam', () => {
      const dropped: BriefItem = { ...RIO, status: 'dropped' };
      const { brief } = applyJudgeVerdict([dropped], verdict(['p1', 'p9'], ['p1']), {
        messageId: 'm1',
        now: LATER,
      });
      expect(brief).toEqual([dropped]);
    });
  });

  describe('fim do turno (D-59)', () => {
    const second: BriefItem = { ...RIO, id: 'p2', text: 'ovos no rodapé', sourceMessageId: 'm2' };

    it('Pedido de turno anterior não é cobrado: o aberto que não é do turno fica superado', () => {
      const { brief, changes } = supersedeAtTurnEnd([RIO, second], { messageId: 'm2', now: LATER });
      expect(brief.map((item) => item.status)).toEqual(['superseded', 'open']);
      expect(brief[0].updatedAt).toBe(LATER.toISOString());
      expect(changes.superseded).toEqual(['p1']);
    });

    it('feito e desistido não mudam, e repetir o fim do turno não muda nada', () => {
      const done: BriefItem = { ...RIO, id: 'p3', status: 'done' };
      const dropped: BriefItem = { ...RIO, id: 'p4', status: 'dropped' };
      const first = supersedeAtTurnEnd([done, dropped, second], { messageId: 'm2', now: LATER });
      expect(first.brief).toEqual([done, dropped, second]);
      const again = supersedeAtTurnEnd(first.brief, { messageId: 'm2', now: LATER });
      expect(again.brief).toEqual(first.brief);
      expect(again.changes.superseded).toEqual([]);
    });

    it('Parar fecha o item do turno parado e o que sobrou do anterior', () => {
      const { brief, changes } = supersedeAtTurnEnd([RIO, second], {
        messageId: 'm2',
        now: LATER,
        stopped: true,
      });
      expect(brief.map((item) => item.status)).toEqual(['superseded', 'superseded']);
      expect(changes.superseded).toEqual(['p1', 'p2']);
    });

    it('item superado só reabre se o cliente pede de novo na mensagem atual', () => {
      const superseded: BriefItem = { ...RIO, status: 'superseded' };
      const ignored = applyDirectorRequests(
        [superseded],
        [open('um rio no meio do campo', 'p1')],
        ctx('m3', LATER, 'deixa o céu azul'),
      );
      expect(ignored.brief[0].status).toBe('superseded');
      const asked = applyDirectorRequests(
        [superseded],
        [open('um rio no meio do campo', 'p1')],
        ctx('m3', LATER, 'coloca o rio no meio do campo'),
      );
      expect(asked.brief[0]).toMatchObject({ status: 'open', sourceMessageId: 'm3' });
      expect(asked.changes.reopened).toEqual(['p1']);
    });
  });
});
