/**
 * WebhookTransport - 通用 HTTP POST webhook 通知传输
 * FR-F01 AC2: 内置 transport 实现
 */

import type { ChannelConfig, ChannelTransport } from '../notification-manager.js';

export class WebhookTransport implements ChannelTransport {
  async send(channel: ChannelConfig, message: string): Promise<void> {
    const url = channel.config.url as string | undefined;
    if (!url) {
      throw new Error('Webhook channel missing "url" in config');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'ACO-Notification/1.0',
    };

    // Support optional auth header
    const secret = channel.config.secret as string | undefined;
    if (secret) {
      headers['Authorization'] = `Bearer ${secret}`;
    }

    // Support custom headers
    const customHeaders = channel.config.headers as Record<string, string> | undefined;
    if (customHeaders && typeof customHeaders === 'object') {
      Object.assign(headers, customHeaders);
    }

    const body = JSON.stringify({
      channelId: channel.channelId,
      message,
      timestamp: new Date().toISOString(),
    });

    const timeoutMs = (channel.config.timeoutMs as number) ?? 10000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Webhook returned HTTP ${response.status}: ${response.statusText}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async testConnection(channel: ChannelConfig): Promise<boolean> {
    const url = channel.config.url as string | undefined;
    if (!url) return false;

    const timeoutMs = (channel.config.timeoutMs as number) ?? 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Send a lightweight test ping
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'ACO-Notification/1.0',
      };

      const secret = channel.config.secret as string | undefined;
      if (secret) {
        headers['Authorization'] = `Bearer ${secret}`;
      }

      const body = JSON.stringify({
        channelId: channel.channelId,
        message: 'ACO connectivity test',
        test: true,
        timestamp: new Date().toISOString(),
      });

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
