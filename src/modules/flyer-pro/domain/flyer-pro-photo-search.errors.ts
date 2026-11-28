/** Por que a busca de fotos no Google não pôde ser feita (os erros da busca e do download, change 47). */

/** Provedor real sem `SERPER_API_KEY`: a busca responde 503 `UNAVAILABLE` sem requisição. */
export type PhotoSearchUnavailableReason = 'NO_API_KEY';

/** `TIMEOUT`: só o prazo de 10 s; `AUTH`: chave recusada; `QUOTA`: créditos acabados; `PROVIDER_ERROR`: o resto. */
export type PhotoSearchFailureReason = 'TIMEOUT' | 'AUTH' | 'QUOTA' | 'PROVIDER_ERROR';
