import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { DatabaseConfig } from './config/database.config';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

import { AuthModule } from './modules/auth/auth.module';
import { ProductsModule } from './modules/products/products.module';
import { ClientsModule } from './modules/clients/clients.module';
import { CollaboratorsModule } from './modules/collaborators/collaborators.module';
import { FlyersModule } from './modules/flyers/flyers.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { FontsModule } from './modules/fonts/fonts.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { HealthModule } from './modules/health/health.module';
import { GalleryModule } from './modules/gallery/gallery.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      useClass: DatabaseConfig,
    }),
    AuthModule,
    ProductsModule,
    ClientsModule,
    CollaboratorsModule,
    FlyersModule,
    TemplatesModule,
    FontsModule,
    UploadsModule,
    DashboardModule,
    HealthModule,
    GalleryModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
  ],
})
export class AppModule {}
