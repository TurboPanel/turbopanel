export {
  emptyComposeDocument,
  isBlankComposeData,
  isComposeDocument,
  isComposeEditorView,
  normalizeCompose,
  pruneBlankComposeData,
  type ComposeComment,
  type ComposeDocument,
  type ComposeEditorView,
  type ComposePresentation,
} from './types.ts'
export {
  ComposeParseError,
  composeDocumentToRuntimeYaml,
  composeDocumentToYaml,
  yamlToComposeDocument,
} from './convert.ts'
export { mergeComposeDocuments, mergeComposeOverlay } from './merge.ts'
export {
  COMPOSE_CUSTOM_TAGS,
  COMPOSE_TAG_KEY,
  composeTagOf,
  isComposeTaggedValue,
  makeComposeTag,
  resolveComposeTags,
  unwrapComposeTag,
  type ComposeTagName,
  type ComposeTaggedValue,
} from './tags.ts'
export {
  collectTraditionalWebServiceNames,
  mergeComposeLayers,
  renameComposeVolumesInLayer,
  stripComposePlacementFromLayer,
  stripTraditionalWebServicesFromLayer,
  type ComposeLayer,
  type ComposeLayerRole,
} from './layers.ts'
export { stripComposeTurbopanelExtensions } from './extensions.ts'
export { renameComposeVolumes } from './rename-volumes.ts'
export { expandComposeServiceInstances } from './expand-instances.ts'
export {
  collectComposeExternalDockerNetworkNames,
  collectServiceComposeNetworkKeys,
  pruneUnreferencedComposeNetworks,
  readComposeExternalDockerNetworkName,
} from './docker-external-networks.ts'
export {
  applyValidatedComposeOption,
  assertComposeDocument,
  stripComposePlacementOption,
  stripProjectComposePlacementOption,
  validateComposeDocument,
  type ComposeValidationIssue,
  type ComposeValidationResult,
} from './validate.ts'
export {
  blockingComposeLintIssues,
  lintComposeYaml,
  type ComposeLintIssue,
  type ComposeLintLevel,
} from './lint.ts'
export {
  isPlacementServerId,
  stripComposePlacement,
  TURBOPANEL_EXTENSION_KEY,
  type ComposeTurbopanelExtension,
} from './placement.ts'
export {
  collectServiceTurbopanelValidationIssues,
  isTraditionalWebComposeService,
  parseServiceTurbopanelExtension,
  readServiceTurbopanelExtension,
  TURBOPANEL_SERVICE_EXTENSION_KEY,
  type ComposeServiceKind,
  type ComposeServiceTurbopanelExtension,
  type TraditionalWebEngine,
} from './service-kind.ts'
export {
  allocateTraditionalWebListenPort,
  assignTraditionalWebListenPorts,
  emptyContainerComposeYaml,
  isSafeTraditionalWebRoot,
  splitTraditionalWebServices,
  type SplitTraditionalWebResult,
  type TraditionalWebSiteSpec,
} from './traditional-web.ts'
export {
  applyVariablesToComposeDocument,
  escapeLiteralComposeValue,
  trimVariableValue,
  type ApplyVariablesResult,
  type DeployVariableEntry,
  type DeployVariableMaterial,
} from './apply-variables.ts'
export {
  applyResourcesToComposeService,
  applyServiceOptionsToComposeDocument,
  buildServiceOptionsMap,
  collectHealthCheckWarnings,
  serviceHasComposeHealthCheck,
  type ApplyServiceOptionsResult,
  type HealthCheckWarning,
  type ServiceDeployHook,
  type ServiceOptionsByComposeName,
} from './apply-service-options.ts'
