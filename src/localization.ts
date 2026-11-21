import { messages } from "./messages";
import type { Status } from "./markdown";
import { englishSnapshotAction } from "./snapshot-actions";

type MessageKey = keyof typeof messages;
type Values = Record<string, string | number>;

export const masteryLabels = {
  new: "unstudied", studied: "studied", mastered: "mastered",
} as const satisfies Record<Status, MessageKey>;

export function createLocalization(obsidianLanguage: string | undefined, timeZone?: string) {
  const language = obsidianLanguage === "ru" ? "ru" : "en";
  const index = language === "ru" ? 1 : 0;
  const number = new Intl.NumberFormat(language);
  const decimal = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 1 });
  const plural = new Intl.PluralRules(language);
  const date = new Intl.DateTimeFormat(language, {
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", timeZone,
  });
  function text(key: MessageKey, values: Values = {}) {
    const message = messages[key][index];
    const template = typeof message === "string" ? message
      : (message as Partial<Record<Intl.LDMLPluralRule, string>>)[plural.select(Number(values.count))] ?? message.other;
    return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
      const value = values[name];
      return typeof value === "number" ? number.format(value) : value ?? placeholder;
    });
  }
  return {
    language,
    text,
    snapshotAction(action: string) { return language === "en" ? englishSnapshotAction(action) : action; },
    date(value: Date | string) { return date.format(new Date(value)); },
    percent(value: number) { return percent.format(value); },
    interval(ms: number) {
      const minutes = Math.max(1, Math.round(ms / 60_000));
      if (minutes < 60) return text("intervalMinutes", { duration: minutes });
      if (minutes < 1440) return text("intervalHours", { duration: decimal.format(minutes / 60) });
      return text("intervalDays", { duration: decimal.format(minutes / 1440) });
    },
  };
}

export let localization = createLocalization(undefined);

export function setInterfaceLanguage(language: string) {
  localization = createLocalization(language);
}

export function t(key: MessageKey, values?: Values) {
  return localization.text(key, values);
}
