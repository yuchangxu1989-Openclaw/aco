/**
 * Built-in notification transports
 * FR-F01 AC1: feishu, telegram, discord, slack, webhook
 */

export { WebhookTransport } from './webhook-transport.js';
export { FeishuTransport } from './feishu-transport.js';
export { TelegramTransport } from './telegram-transport.js';
export { DiscordTransport } from './discord-transport.js';
export { SlackTransport } from './slack-transport.js';

import { WebhookTransport } from './webhook-transport.js';
import { FeishuTransport } from './feishu-transport.js';
import { TelegramTransport } from './telegram-transport.js';
import { DiscordTransport } from './discord-transport.js';
import { SlackTransport } from './slack-transport.js';
import type { ChannelTransport } from '../notification-manager.js';
import type { NotificationChannelType } from '../../types/index.js';

/**
 * Get all built-in transports keyed by channel type
 */
export function getBuiltinTransports(): Map<NotificationChannelType, ChannelTransport> {
  const transports = new Map<NotificationChannelType, ChannelTransport>();
  transports.set('webhook', new WebhookTransport());
  transports.set('feishu', new FeishuTransport());
  transports.set('telegram', new TelegramTransport());
  transports.set('discord', new DiscordTransport());
  transports.set('slack', new SlackTransport());
  return transports;
}
