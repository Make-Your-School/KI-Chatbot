import { config } from "./config.ts";

const compactWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

export const debugEnabled = (): boolean => config.debug.pipeline;

export const debugContentEnabled = (): boolean =>
  config.debug.pipeline && config.debug.includeContent;

export const previewText = (value: string, max = config.debug.previewChars): string => {
  const compact = compactWhitespace(value);
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}...`;
};

const serialize = (data: unknown): string => {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
};

export const debugLog = (scope: string, message: string, data?: unknown): void => {
  if (!debugEnabled()) return;
  if (data === undefined) {
    console.log(`[debug:${scope}] ${message}`);
    return;
  }
  console.log(`[debug:${scope}] ${message} ${serialize(data)}`);
};

export const debugContentLog = (
  scope: string,
  message: string,
  value: string
): void => {
  if (!debugContentEnabled()) return;
  console.log(`[debug:${scope}] ${message} ${previewText(value)}`);
};