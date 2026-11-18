import { useDocumentsE2e } from './flyer-pro-documents.e2e.testutil';

/** O preparo comum dos e2e das exportações (só testes): o do encarte, mais as duas rotas chamadas por id de encarte. */
export const EXPORTS_PATH = (documentId: string) => `/flyer-pro/documents/${documentId}/exports`;

export function useExportsE2e() {
  const documents = useDocumentsE2e({ scenes: false });
  const { h } = documents;
  return {
    ...documents,
    /** `POST` do N8 com o token da semente (a Ana) ou com os cabeçalhos dados (o Bruno, por exemplo). */
    register: (documentId: string, body: object, headers?: Record<string, string>) =>
      headers
        ? h
            .http()
            .post(`/v1${EXPORTS_PATH(documentId)}`)
            .set(headers)
            .send(body)
        : h.post(EXPORTS_PATH(documentId), body),
    /** `GET` do N9, com o token da semente ou com os cabeçalhos dados. */
    history: (documentId: string, query = '', headers?: Record<string, string>) =>
      headers
        ? h
            .http()
            .get(`/v1${EXPORTS_PATH(documentId)}${query}`)
            .set(headers)
        : h.get(`${EXPORTS_PATH(documentId)}${query}`),
    /** As duas rotas sem o cabeçalho `Authorization`. */
    noToken: {
      register: (documentId: string, body: object) =>
        h
          .http()
          .post(`/v1${EXPORTS_PATH(documentId)}`)
          .send(body),
      history: (documentId: string) => h.http().get(`/v1${EXPORTS_PATH(documentId)}`),
    },
  };
}
