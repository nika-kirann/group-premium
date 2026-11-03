import { Bot } from 'grammy';
import { config } from './config.js';

// Single shared grammY bot instance (webhook mode only - never bot.start()).
export const bot = new Bot(config.botToken);

/**
 * Call any Bot API method by name. Used for newer methods (setChatMemberTag,
 * editUserStarSubscription) so the project keeps working even if the installed
 * grammY typings predate them - grammY's raw API forwards any method name.
 */
export function callApi(method, payload) {
  return bot.api.raw[method](payload);
}

/** grammY's bot.botInfo throws before init(); this returns null instead. */
export function botInfoSafe() {
  try { return bot.botInfo; } catch { return null; }
}
