import { applyDirectorRequests, BriefItem, supersedeAtTurnEnd, turnItems } from './scene-brief';
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
const RIO: BriefItem = {
  id: 'p1',
  text: 'um rio no meio do campo',
  status: 'open',
  sourceMessageId: 'm1',
  updatedAt: NOW.toISOString(),
};

describe('scene-brief, turno', () => {
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
