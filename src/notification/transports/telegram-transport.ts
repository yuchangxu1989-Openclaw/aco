/**
 * TelegramTransport - Telegram Bot API 通知传输
 * FR-F01 AC1: Telegram 渠道支持
 *
 * 配置项:
 *   - botToken: Telegram Bot API token
 *   - chatId: 目标 chat ID (用户/群组/频道)
 *   - parseMode (可选): 'HTML' | 'Markdown' | 'MarkdownV2', 默认无格式
 */

import type { ChannelConfig, ChannelTransport } from '../notification-manager.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

export class TelegramTransport implements ChannelTransport {
  async send(channel: ChannelConfig, message: string): Promise<void> {
    const botToken = channel.config.botToken as string | undefined;
    const chatId = channel.config.chatId as string | number | undefined;

    if (!botToken) {
      throw new Error('Telegram channel missing "botToken" in config');
    }
    if (!chatId) {
      throw new Error('Telegram channel missing "chatId" in config');
    }

    const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
    const parseMode = channel.config.parseMode as string | undefined;

    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: message,
    };
    if (parseMode) {
      body.parse_mode = parseMode;
    }

    // Disable link previews for cleaner notification messages
    body.disable_web_page_preview = true;

    const timeoutMs = (channel.config.timeoutMs as number) ?? 10000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Telegram API returned HTTP ${response.status}: ${text}`);
      }

      const result = await response.json() as { ok?: boolean; description?: string };
      if (!result.ok) {
        throw new Error(`Telegram API error: ${result.description ?? 'unknown'}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async testConnection(channel: ChannelConfig): Promise<boolean> {
    const botToken = channel.config.botToken as string | undefined;
    const chatId = channel.config.chatId as string | number | undefined;

    if (!botToken || !chatId) return false;

    const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
    const timeoutMs = (channel.config.timeoutMs as number) ?? 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const body = {
        chat_id: chatId,
        text: 'ACO connectivity test',
        disable_notification: true,
        disable_web_page_preview: true,
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) return false;
      const result = await response.json() as { ok?: boolean };
      return result.ok === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
