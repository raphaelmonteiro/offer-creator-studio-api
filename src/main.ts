import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { configureHttpApp } from './common/config/http-app.config';
import { pinUploadsDirEnv, resolveUploadsDir } from './common/config/uploads-dir';
import { useUploadsStatic } from './common/config/uploads-static.config';

async function bootstrap() {
  new Logger('Bootstrap').log(`Uploads em ${pinUploadsDirEnv()}`);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false, // Disable default body parser to have full control
  });

  // Body parsers (JSON até 100 MB, sem ler multipart), prefixo `v1`, filtro e pipe globais: compartilhados com o
  // app de teste do e2e (`common/config/http-app.config.ts`).
  configureHttpApp(app);

  // CORS
  app.enableCors();

  // Arquivos estáticos de /uploads/ com CORS (compartilhado com o app de teste do e2e).
  useUploadsStatic(app, resolveUploadsDir(process.env.UPLOAD_DEST));

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('Sistema de Encartes API')
    .setDescription('API REST para sistema de criação de encartes/flyers de supermercado')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth', // This name here is important for matching up with @ApiBearerAuth() in your controller!
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Swagger documentation: http://localhost:${port}/api`);
}

bootstrap();
