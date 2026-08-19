// =====================================================================
// Dependency injection Langium.
//
// Servono solo parsing, linking e validazione: si usano i servizi core,
// senza il livello LSP. I documenti sono stringhe che arrivano dalla
// GUI, quindi EmptyFileSystem basta.
// =====================================================================

import type { LangiumCoreServices, LangiumSharedCoreServices, Module, PartialLangiumCoreServices } from 'langium';
import {
  createDefaultCoreModule,
  createDefaultSharedCoreModule,
  EmptyFileSystem,
  inject,
} from 'langium';
import { OrcristGeneratedModule, OrcristGeneratedSharedModule } from './generated/module.js';
import { registerValidationChecks } from './orcrist-validator.js';

export type OrcristServices = LangiumCoreServices;

export const OrcristModule: Module<OrcristServices, PartialLangiumCoreServices> = {};

export function createOrcristServices(): {
  shared: LangiumSharedCoreServices;
  Orcrist: OrcristServices;
} {
  const shared = inject(createDefaultSharedCoreModule(EmptyFileSystem), OrcristGeneratedSharedModule);
  const Orcrist = inject(createDefaultCoreModule({ shared }), OrcristGeneratedModule, OrcristModule);
  shared.ServiceRegistry.register(Orcrist);
  registerValidationChecks(Orcrist);
  return { shared, Orcrist };
}
