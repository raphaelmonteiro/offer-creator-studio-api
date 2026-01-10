import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { SmartValidationPipe } from './common/pipes/smart-validation.pipe';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false, // Disable default body parser to have full control
  });

  // Register body parsers manually with conditional logic
  const bodyParser = require('body-parser');
  
  // JSON body parser - skip for multipart requests
  app.use((req: any, res: any, next: any) => {
    const contentType = req.headers['content-type'] || '';
    
    if (contentType.includes('multipart/form-data')) {
      // Skip body parsing for multipart - FileInterceptor will handle it
      return next();
    }
    
    // Apply JSON parser for non-multipart requests
    bodyParser.json({ limit: '50mb' })(req, res, next);
  });

  // URL encoded body parser - skip for multipart requests
  app.use((req: any, res: any, next: any) => {
    const contentType = req.headers['content-type'] || '';
    
    if (contentType.includes('multipart/form-data')) {
      return next();
    }
    
    bodyParser.urlencoded({ limit: '50mb', extended: true })(req, res, next);
  });

  // Global prefix
  app.setGlobalPrefix('v1');

  // CORS
  app.enableCors();

  // Serve static files
  const uploadPath = process.env.UPLOAD_DEST || './uploads';
  app.useStaticAssets(join(process.cwd(), uploadPath), {
    prefix: '/uploads/',
  });

  // Global exception filter
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global validation pipe with smart handling for multipart requests
  app.useGlobalPipes(
    new SmartValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      skipMissingProperties: false,
    }),
  );

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
