import { INestApplication } from '@nestjs/common';
import * as bodyParser from 'body-parser';
import { HttpExceptionFilter } from '../filters/http-exception.filter';
import { SmartValidationPipe } from '../pipes/smart-validation.pipe';

type Next = (error?: unknown) => void;

/** Corpo multipart é lido pelo `FileInterceptor` da rota, não por estes leitores. */
const isMultipart = (req: { headers: Record<string, unknown> }): boolean =>
  String(req.headers['content-type'] || '').includes('multipart/form-data');

/** JSON e `urlencoded` até 100 MB, sem ler o corpo multipart (o app é criado com `bodyParser: false`). */
export function useBodyParsers(app: INestApplication): void {
  const json = bodyParser.json({ limit: '100mb' });
  const urlencoded = bodyParser.urlencoded({ limit: '100mb', extended: true });
  app.use((req: any, res: any, next: Next) => (isMultipart(req) ? next() : json(req, res, next)));
  app.use((req: any, res: any, next: Next) =>
    isMultipart(req) ? next() : urlencoded(req, res, next),
  );
}

/**
 * A configuração HTTP de produção que o `main.ts` e o app de teste do e2e compartilham: leitores de corpo, prefixo
 * `/v1`, filtro global de erros e pipe global de validação. O `ResponseInterceptor` entra pelo `APP_INTERCEPTOR` do
 * módulo (o `AppModule` em produção). CORS e Swagger ficam só no `main.ts`; os arquivos estáticos de `/uploads/` vêm de
 * `useUploadsStatic` (`uploads-static.config.ts`), que o `main.ts` sempre chama e o app de teste chama quando o spec pede.
 */
export function configureHttpApp(app: INestApplication): void {
  useBodyParsers(app);
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(
    new SmartValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      skipMissingProperties: false,
    }),
  );
}
