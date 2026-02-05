"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FlyersModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const flyers_controller_1 = require("./flyers.controller");
const flyers_service_1 = require("./flyers.service");
const flyer_entity_1 = require("./entities/flyer.entity");
const uploads_module_1 = require("../uploads/uploads.module");
const clients_module_1 = require("../clients/clients.module");
let FlyersModule = class FlyersModule {
};
exports.FlyersModule = FlyersModule;
exports.FlyersModule = FlyersModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([flyer_entity_1.Flyer]),
            uploads_module_1.UploadsModule,
            clients_module_1.ClientsModule,
        ],
        controllers: [flyers_controller_1.FlyersController],
        providers: [flyers_service_1.FlyersService],
        exports: [flyers_service_1.FlyersService],
    })
], FlyersModule);
//# sourceMappingURL=flyers.module.js.map