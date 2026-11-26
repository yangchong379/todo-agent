import { isTaskDate } from "../shared/tasks.ts";

export function today() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: process.env.TODO_TIME_ZONE || "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export const dateExpression =
  /(?:\d{4}-\d{2}-\d{2}|今天|今晚|明天|明早|明晚|后天|(?:本|这|下)周[一二三四五六日天])/u;

export function resolveDate(text: string, currentDay: string) {
  if (isTaskDate(text)) return text;
  const offsets: Record<string, number> = {
    今天: 0,
    今晚: 0,
    明天: 1,
    明早: 1,
    明晚: 1,
    后天: 2,
  };
  const day = new Date(currentDay + "T00:00:00Z");
  const week = /^(本|这|下)周([一二三四五六日天])$/u.exec(text);
  const offset = week
    ? (week[1] === "下" ? 7 : 0) +
      ("一二三四五六日天".indexOf(week[2]) % 7) -
      ((day.getUTCDay() + 6) % 7)
    : Object.hasOwn(offsets, text)
      ? offsets[text]
      : undefined;
  if (offset === undefined) return undefined;
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}
