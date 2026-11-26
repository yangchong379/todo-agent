import { dayPeriods, isDayPeriod, isTaskDate } from "../shared/tasks.ts";

export function today() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: process.env.TODO_TIME_ZONE || "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export const dateExpression =
  /(?:\d{4}-\d{2}-\d{2}|今天|今晚|明天|明早|明晚|大后天|后天|(?:本|这|下)?(?:周|星期|礼拜)[一二三四五六日天])/u;

export function resolveDate(text: string, currentDay: string) {
  if (isTaskDate(text)) return text;
  const offsets: Record<string, number> = {
    今天: 0,
    今晚: 0,
    明天: 1,
    明早: 1,
    明晚: 1,
    后天: 2,
    大后天: 3,
  };
  const day = new Date(currentDay + "T00:00:00Z");
  const week = /^(本|这|下)?(?:周|星期|礼拜)([一二三四五六日天])$/u.exec(text);
  const weekday = (day.getUTCDay() + 6) % 7;
  const dayOfWeek = week ? "一二三四五六日天".indexOf(week[2]) % 7 : 0;
  const difference = dayOfWeek - weekday;
  const offset = week
    ? difference + (week[1] === "下" || (!week[1] && difference < 0) ? 7 : 0)
    : Object.hasOwn(offsets, text)
      ? offsets[text]
      : undefined;
  if (offset === undefined) return undefined;
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

const clockPattern =
  "[0-9]{1,2}[:：][0-9]{2}|[0-9零〇一二两三四五六七八九十]{1,3}点(?:半|一刻|三刻|[0-9零〇一二三四五六七八九十]{1,3}分?)?";
const schedulePrefix = new RegExp(
  "^(?<day>" +
    dateExpression.source +
    ")?\\s*(?<period>" +
    dayPeriods.join("|") +
    ")?\\s*(?<clock>" +
    clockPattern +
    ")?",
  "u",
);

function number(text: string): number {
  if (/^[0-9]+$/u.test(text)) return Number(text);
  const digits = "零一二三四五六七八九";
  const value = text.replace(/两/g, "二").replace(/〇/g, "零");
  if (value.length === 1 && value !== "十") return digits.indexOf(value);
  const [tens, units] = value.split("十");
  if (units !== undefined)
    return (tens ? digits.indexOf(tens) : 1) * 10 + (units ? digits.indexOf(units) : 0);
  return Number(
    value
      .split("")
      .map((char) => digits.indexOf(char))
      .join(""),
  );
}

function resolveClock(clock: string, period?: string) {
  const numeric = /^(\d{1,2})[:：](\d{2})$/u.exec(clock);
  const spoken = /^(.*?)点(.*)$/u.exec(clock);
  const minutes = numeric
    ? Number(numeric[2])
    : !spoken?.[2]
      ? 0
      : spoken[2] === "半"
        ? 30
        : spoken[2] === "一刻"
          ? 15
          : spoken[2] === "三刻"
            ? 45
            : number(spoken[2].replace(/分$/u, ""));
  let hours = numeric ? Number(numeric[1]) : spoken ? number(spoken[1]) : -1;
  if (/^(?:下午|傍晚|晚上|夜里|中午)$/u.test(period ?? "") && hours >= 1 && hours < 12) {
    hours += 12;
  }
  if (period === "凌晨" && hours === 12) hours = 0;
  if (
    !Number.isInteger(hours) ||
    hours < 0 ||
    hours >= 24 ||
    !Number.isInteger(minutes) ||
    minutes < 0 ||
    minutes >= 60
  )
    return undefined;
  return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0");
}

export function splitSchedule(text: string) {
  const match = schedulePrefix.exec(text.trim());
  const { day, period, clock } = match?.groups ?? {};
  if (!match || (!day && !period && !clock)) return undefined;
  return {
    day,
    period,
    clock,
    expression: match[0].trim(),
    rest: text.trim().slice(match[0].length).trim(),
  };
}

export function resolveSchedule(when: string, current: string) {
  const parts = splitSchedule(when);
  if (!parts || parts.rest) return undefined;
  const { day, period, clock } = parts;
  const dueDate = day ? resolveDate(day, current) : undefined;
  const clockPeriod =
    period ?? (day === "今晚" || day === "明晚" ? "晚上" : day === "明早" ? "早上" : undefined);
  const dueTime = clock ? resolveClock(clock, clockPeriod) : undefined;
  if ((day && !dueDate) || (clock && !dueTime)) return undefined;
  return { dueDate, dueTime, period: isDayPeriod(clockPeriod) ? clockPeriod : undefined };
}

export function scheduleLabel(date?: string, time?: string, period?: string) {
  return [date, time ?? period].filter(Boolean).join(" ");
}
