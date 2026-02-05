"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("@nestjs/typeorm");
const core_1 = require("@nestjs/core");
const database_config_1 = require("./config/database.config");
const response_interceptor_1 = require("./common/interceptors/response.interceptor");
const auth_module_1 = require("./modules/auth/auth.module");
const products_module_1 = require("./modules/products/products.module");
const clients_module_1 = require("./modules/clients/clients.module");
const collaborators_module_1 = require("./modules/collaborators/collaborators.module");
const flyers_module_1 = require("./modules/flyers/flyers.module");
const templates_module_1 = require("./modules/templates/templates.module");
const fonts_module_1 = require("./modules/fonts/fonts.module");
const uploads_module_1 = require("./modules/uploads/uploads.module");
const dashboard_module_1 = require("./modules/dashboard/dashboard.module");
const health_module_1 = require("./modules/health/health.module");
const gallery_module_1 = require("./modules/gallery/gallery.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({
                isGlobal: true,
                envFilePath: '.env',
            }),
            typeorm_1.TypeOrmModule.forRootAsync({
                useClass: database_config_1.DatabaseConfig,
            }),
            auth_module_1.AuthModule,
            products_module_1.ProductsModule,
            clients_module_1.ClientsModule,
            collaborators_module_1.CollaboratorsModule,
            flyers_module_1.FlyersModule,
            templates_module_1.TemplatesModule,
            fonts_module_1.FontsModule,
            uploads_module_1.UploadsModule,
            dashboard_module_1.DashboardModule,
            health_module_1.HealthModule,
            gallery_module_1.GalleryModule,
        ],
        providers: [
            {
                provide: core_1.APP_INTERCEPTOR,
                useClass: response_interceptor_1.ResponseInterceptor,
            },
        ],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map