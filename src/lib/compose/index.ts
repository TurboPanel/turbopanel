export {
  type ComposeComment,
  type ComposeDocument,
  type ComposeEditorView,
  type ComposePresentation,
  emptyComposeDocument,
  isBlankComposeData,
  isComposeDocument,
  isComposeEditorView,
  normalizeCompose,
  pruneBlankComposeData,
} from './types.ts'
export {
  composeDocumentToRuntimeYaml,
  composeDocumentToYaml,
  ComposeParseError,
  yamlToComposeDocument,
} from './convert.ts'
export { mergeComposeDocuments, mergeComposeOverlay } from './merge.ts'
export {
  COMPOSE_CUSTOM_TAGS,
  COMPOSE_TAG_KEY,
  type ComposeTaggedValue,
  type ComposeTagName,
  composeTagOf,
  isComposeTaggedValue,
  makeComposeTag,
  resolveComposeTags,
  unwrapComposeTag,
} from './tags.ts'
export {
  collectTraditionalWebServiceNames,
  type ComposeLayer,
  type ComposeLayerRole,
  mergeComposeLayers,
  renameComposeVolumesInLayer,
  stripComposePlacementFromLayer,
  stripTraditionalWebServicesFromLayer,
} from './layers.ts'
export { stripComposeTurbopanelExtensions } from './extensions.ts'
export { renameComposeVolumes } from './rename-volumes.ts'
export { expandComposeServiceInstances } from './expand-instances.ts'
export {
  compileRuntimeCompose,
  compileRuntimeComposeDocument,
  type CompileRuntimeOptions,
  type CompileRuntimeResult,
} from './compile-runtime.ts'
export { SHA256_HEX_RE, sha256HexUtf8 } from './desired-hash.ts'
export {
  collectComposeExternalDockerNetworkNames,
  collectServiceComposeNetworkKeys,
  pruneUnreferencedComposeNetworks,
  readComposeExternalDockerNetworkName,
} from './docker-external-networks.ts'
export {
  applyValidatedComposeOption,
  assertComposeDocument,
  type ComposeValidateOptions,
  type ComposeValidationIssue,
  type ComposeValidationResult,
  stripComposePlacementOption,
  stripProjectComposePlacementOption,
  validateComposeDocument,
} from './validate.ts'
export {
  blockingComposeLintIssues,
  type ComposeLintIssue,
  type ComposeLintLevel,
  type ComposeLintOptions,
  lintComposeYaml,
} from './lint.ts'
export {
  applyComposePlacement,
  type ComposeTurbopanelExtension,
  isPlacementServerId,
  stripComposePlacement,
  TURBOPANEL_EXTENSION_KEY,
} from './placement.ts'
export {
  collectServiceTurbopanelValidationIssues,
  type ComposeServiceKind,
  type ComposeServiceSourceExtension,
  type ComposeServiceTurbopanelExtension,
  type ComposeSourceBuildKind,
  isHostNativeServiceKind,
  isNodeComposeService,
  isSafeRoot,
  isTraditionalWebComposeService,
  type NativeRuntimeFramework,
  parseServiceSourceExtension,
  parseServiceTurbopanelExtension,
  readServiceSourceExtension,
  readServiceTurbopanelExtension,
  SOURCE_BRANCH_MAX_LENGTH,
  SOURCE_COMMAND_MAX_LENGTH,
  type SourceIdResolver,
  type TraditionalWebEngine,
  TURBOPANEL_SERVICE_EXTENSION_KEY,
} from './service-kind.ts'
export {
  assignNativeAppListenPorts,
  NATIVE_APP_DEFAULT_FRAMEWORK,
  type NativeAppServiceSpec,
  type SplitNativeAppResult,
  splitNativeAppServices,
} from './native-app.ts'
export {
  allocateTraditionalWebListenPort,
  assignTraditionalWebListenPorts,
  emptyContainerComposeYaml,
  isSafeTraditionalWebRoot,
  type SplitTraditionalWebResult,
  splitTraditionalWebServices,
  type TraditionalWebSiteSpec,
} from './traditional-web.ts'
export {
  type ApplyVariablesError,
  type ApplyVariablesResult,
  applyVariablesToComposeDocument,
  type DeployVariableEntry,
  type DeployVariableMaterial,
  escapeLiteralComposeValue,
  isApplyVariablesError,
  trimVariableValue,
} from './apply-variables.ts'
export { type DeploySecretPlanEntry } from './secret-files.ts'
export {
  type ParsedVariableRef,
  parseExactVariableRef,
  type VariableRefScope,
} from './variable-refs.ts'
export {
  applyResourcesToComposeService,
  type ApplyServiceOptionsResult,
  applyServiceOptionsToComposeDocument,
  buildServiceOptionsMap,
  collectHealthCheckWarnings,
  type HealthCheckWarning,
  type ServiceDeployHook,
  serviceHasComposeHealthCheck,
  type ServiceOptionsByComposeName,
} from './apply-service-options.ts'
