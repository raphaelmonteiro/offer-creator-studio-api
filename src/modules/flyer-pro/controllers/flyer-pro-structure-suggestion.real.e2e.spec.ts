import { overrideEnv } from '../../../shared/testing/e2e-app';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import { exampleItemSeeds, exampleRequestFor } from '../domain/structure-suggestion.testutil';
import {
  DOCUMENTS_URL,
  envelope,
  useDocumentsE2e,
} from '../testing/flyer-pro-documents.e2e.testutil';
import { insertDocumentWithItems } from '../testing/flyer-pro-documents.fixture';

/**
 * e2e do N19 com o provedor `real` (change 24-add-flyer-pro-structure-suggestion-api): o harness esvazia a `OPENAI_API_KEY`,
 * mesmo que o shell que roda a suíte a tenha, então a rota recusa com 422 `NO_API_KEY` e nenhuma chamada sai. A variável do
 * provedor é lida quando o app sobe, por isso este caso tem o seu próprio arquivo e o seu próprio app.
 */
describeIfE2eDb(
  'POST /v1/flyer-pro/documents/:id/structure-suggestion com o provedor real, sem chave (e2e)',
  () => {
    let restoreEnv: () => void;
    beforeAll(() => {
      restoreEnv = overrideEnv({ FLYER_PRO_STRUCTURE_AI_PROVIDER: 'real' });
    });
    afterAll(() => restoreEnv());

    const { h, clientA } = useDocumentsE2e({ scenes: false });

    it('responde 422 FLYER_PRO_STRUCTURE_AI_DISABLED com NO_API_KEY, sem chamar a OpenAI', async () => {
      const { id, itemIds } = await insertDocumentWithItems(
        h.dataSource,
        { clientId: clientA(), name: 'Ofertas da semana 47' },
        exampleItemSeeds(),
      );

      const response = await h.post(
        `${DOCUMENTS_URL}/${id}/structure-suggestion`,
        exampleRequestFor(itemIds),
      );

      expect(response.status).toBe(422);
      expect(envelope<unknown>(response).error).toMatchObject({
        code: 'FLYER_PRO_STRUCTURE_AI_DISABLED',
        details: { reason: 'NO_API_KEY' },
      });
      expect(h.app.config.get('OPENAI_API_KEY')).toBe('');
    });
  },
);
