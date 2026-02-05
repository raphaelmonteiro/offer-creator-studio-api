"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateFlyerDto = void 0;
const swagger_1 = require("@nestjs/swagger");
const create_flyer_dto_1 = require("./create-flyer.dto");
class UpdateFlyerDto extends (0, swagger_1.PartialType)(create_flyer_dto_1.CreateFlyerDto) {
}
exports.UpdateFlyerDto = UpdateFlyerDto;
//# sourceMappingURL=update-flyer.dto.js.map