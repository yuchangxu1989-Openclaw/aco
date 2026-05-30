/**
 * 配置模块 — 域 H：配置与渐进式披露
 */

export { ConfigManager } from './config-manager.js';
export type { ConfigManagerOptions, ConfigChangeEvent, FileSystem } from './config-manager.js';
export {
  validateConfig,
  generateMinimalConfig,
  generateAnnotatedConfig,
} from './config-schema.js';
export type {
  AcoFileConfig,
  ConfigValidationError,
  FeatureFlag,
} from './config-schema.js';
export {
  FEATURE_LAYERS,
  getFeatureLayer,
  getFeatureLevel,
  isFeatureEnabled,
  enableFeature,
  disableFeature,
  getFeatureStatus,
  shouldDowngradeGovernance,
} from './feature-layers.js';
export type { FeatureLayer } from './feature-layers.js';
