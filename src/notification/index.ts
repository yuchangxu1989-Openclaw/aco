export { NotificationManager, DEFAULT_NOTIFICATION_CONFIG, KNOWN_HOST_EVENTS, validateEventName } from './notification-manager.js';
export type {
  ChannelConfig,
  ChannelTransport,
  DeliveryRecord,
  NotificationEventType,
  NotificationManagerConfig,
  NotificationPayload,
  SubscriptionFilter,
  NotificationTaskSource,
  CompletionEventPayload,
  NotificationTemplate,
  KnownHostEvent,
  EventListenerStatus,
} from './notification-manager.js';
export {
  WebhookTransport,
  FeishuTransport,
  TelegramTransport,
  DiscordTransport,
  SlackTransport,
  getBuiltinTransports,
} from './transports/index.js';
export { ClosureGuard, DEFAULT_CLOSURE_GUARD_CONFIG } from './closure-guard.js';
export type {
  ClosureGuardConfig,
  PendingClosure,
  TaskCompletionEvent,
  PromptBuildContext,
  PromptInjectionResult,
} from './closure-guard.js';
