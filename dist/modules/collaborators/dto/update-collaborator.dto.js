"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateCollaboratorDto = void 0;
const swagger_1 = require("@nestjs/swagger");
const create_collaborator_dto_1 = require("./create-collaborator.dto");
class UpdateCollaboratorDto extends (0, swagger_1.PartialType)((0, swagger_1.OmitType)(create_collaborator_dto_1.CreateCollaboratorDto, ['password'])) {
}
exports.UpdateCollaboratorDto = UpdateCollaboratorDto;
//# sourceMappingURL=update-collaborator.dto.js.map