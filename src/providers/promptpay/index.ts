import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import PromptPayProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  services: [PromptPayProviderService],
})
