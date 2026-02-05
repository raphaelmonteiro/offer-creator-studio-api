"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const swagger_1 = require("@nestjs/swagger");
const path_1 = require("path");
const app_module_1 = require("./app.module");
const http_exception_filter_1 = require("./common/filters/http-exception.filter");
const smart_validation_pipe_1 = require("./common/pipes/smart-validation.pipe");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule, {
        bodyParser: false,
    });
    const bodyParser = require('body-parser');
    app.use((req, res, next) => {
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return next();
        }
        bodyParser.json({ limit: '100mb' })(req, res, next);
    });
    app.use((req, res, next) => {
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return next();
        }
        bodyParser.urlencoded({ limit: '100mb', extended: true })(req, res, next);
    });
    app.setGlobalPrefix('v1');
    app.enableCors();
    const uploadPath = process.env.UPLOAD_DEST || './uploads';
    app.useStaticAssets((0, path_1.join)(process.cwd(), uploadPath), {
        prefix: '/uploads/',
    });
    app.useGlobalFilters(new http_exception_filter_1.HttpExceptionFilter());
    app.useGlobalPipes(new smart_validation_pipe_1.SmartValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        skipMissingProperties: false,
    }));
    const config = new swagger_1.DocumentBuilder()
        .setTitle('Sistema de Encartes API')
        .setDescription('API REST para sistema de criação de encartes/flyers de supermercado')
        .setVersion('1.0')
        .addBearerAuth({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
    }, 'JWT-auth')
        .build();
    const document = swagger_1.SwaggerModule.createDocument(app, config);
    swagger_1.SwaggerModule.setup('api', app, document);
    const port = process.env.PORT || 3000;
    await app.listen(port);
    console.log(`Application is running on: http://localhost:${port}`);
    console.log(`Swagger documentation: http://localhost:${port}/api`);
}
bootstrap();
//# sourceMappingURL=main.js.map