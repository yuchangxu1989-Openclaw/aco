/**
 * SlackTransport - Slack Incoming Webhook 通知传输
 * FR-F01 AC1: Slack 渠道支持
 *
 * 配置项:
 *   - webhookUrl: Slack Incoming Webhook URL (https://hooks.slack.com/services/...)
 *   - channel (可选): 覆盖默认频道 (如 #ops-alerts)
 *   - username (可选): 覆盖显示名
 *   - iconEmoji (可选): 覆盖头像 emoji (如 :robot_face:)
 */

import type { ChannelConfig, ChannelTransport } from '../notification-manager.js';

export class SlackTransport implements ChannelTransport {
  async send(channel: ChannelConfig, message: string): Promise<void> {
    const webhookUrl = channel.config.webhookUrl as string | undefined;
    if (!webhookUrl) {
      throw new Error('Slack channel missing "webhookUrl" in config');
    }

    const body: Record<string, unknown> = {
      text: message,
    };

    const slackChannel = channel.config.channel as string | undefined;
    if (slackChannel) {
      body.channel = slackChannel;
    }

    const username = channel.config.username as string | undefined;
    if (username) {
      body.username = username;
    }

    const iconEmoji = channel.config.iconEmoji as string | undefined;
    if (iconEmoji) {
      body.icon_emoji = iconEmoji;
    }

    const timeoutMs = (channel.config.timeoutMs as number) ?? 10000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Slack webhook returned HTTP ${response.status}: ${text}`);
      }

      // Slack returns "ok" as plain text on success
      const text = await response.text();
      if (text !== 'ok') {
        throw new Error(`Slack webhook error: ${text}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async testConnection(channel: ChannelConfig): Promise<boolean> {
    const webhookUrl = channel.config.webhookUrl as string | undefined;
    if (!webhookUrl) return false;

    const timeoutMs = (channel.config.timeoutMs as number) ?? 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Send a lightweight test message
      const body = {
        text: 'ACO connectivity test',
      };

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) return false;
      const text = await response.text();
      return text === 'ok';
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
