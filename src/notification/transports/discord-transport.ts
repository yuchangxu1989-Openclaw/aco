/**
 * DiscordTransport - Discord Webhook 通知传输
 * FR-F01 AC1: Discord 渠道支持
 *
 * 配置项:
 *   - webhookUrl: Discord webhook URL (https://discord.com/api/webhooks/...)
 *   - username (可选): 覆盖 webhook 显示名
 *   - avatarUrl (可选): 覆盖 webhook 头像
 */

import type { ChannelConfig, ChannelTransport } from '../notification-manager.js';

export class DiscordTransport implements ChannelTransport {
  async send(channel: ChannelConfig, message: string): Promise<void> {
    const webhookUrl = channel.config.webhookUrl as string | undefined;
    if (!webhookUrl) {
      throw new Error('Discord channel missing "webhookUrl" in config');
    }

    const body: Record<string, unknown> = {
      content: this.truncateMessage(message, 2000),
    };

    const username = channel.config.username as string | undefined;
    if (username) {
      body.username = username;
    }

    const avatarUrl = channel.config.avatarUrl as string | undefined;
    if (avatarUrl) {
      body.avatar_url = avatarUrl;
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

      // Discord returns 204 No Content on success
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Discord webhook returned HTTP ${response.status}: ${text}`);
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
      // Discord: GET on webhook URL returns webhook info without sending a message
      const response = await fetch(webhookUrl, {
        method: 'GET',
        signal: controller.signal,
      });

      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Discord message content limit is 2000 characters */
  private truncateMessage(message: string, maxLen: number): string {
    if (message.length <= maxLen) return message;
    return message.slice(0, maxLen - 3) + '...';
  }
}
