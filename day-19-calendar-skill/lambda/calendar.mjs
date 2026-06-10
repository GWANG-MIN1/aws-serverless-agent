import ical from "node-ical";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_ICS_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeCalendarUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new Error("calendar is not configured");
  }

  const value = rawUrl.trim().replace(/^webcal:\/\//i, "https://");
  const url = new URL(value);

  if (url.protocol !== "https:") {
    throw new Error("calendar URL must use https or webcal");
  }
  if (url.username || url.password) {
    throw new Error("calendar URL must not contain basic-auth credentials");
  }
  if (url.hostname !== "icloud.com" && !url.hostname.endsWith(".icloud.com")) {
    throw new Error("calendar URL must be an iCloud public calendar URL");
  }

  return url.toString();
}

function partsAt(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
}

function localYmd(date, timeZone) {
  const parts = partsAt(date, timeZone);
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function dateOnlyYmd(date) {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function shiftYmd(ymd, days) {
  const [year, month, day] = ymd.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return [
    String(shifted.getUTCFullYear()).padStart(4, "0"),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function localDateTime(date, timeZone) {
  const parts = partsAt(date, timeZone);
  return `${localYmd(date, timeZone)}T${[
    String(parts.hour).padStart(2, "0"),
    String(parts.minute).padStart(2, "0"),
    String(parts.second).padStart(2, "0"),
  ].join(":")}`;
}

function localHm(date, timeZone) {
  const parts = partsAt(date, timeZone);
  return [
    String(parts.hour).padStart(2, "0"),
    String(parts.minute).padStart(2, "0"),
  ].join(":");
}

function koreanDateLabel(date, timeZone) {
  const parts = partsAt(date, timeZone);
  const weekday = new Intl.DateTimeFormat("ko-KR", {
    timeZone,
    weekday: "short",
  }).format(date);
  return `${parts.year}년 ${parts.month}월 ${parts.day}일 (${weekday})`;
}

function koreanDateLabelFromYmd(ymd) {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "UTC",
    weekday: "short",
  }).format(date);
  return `${year}년 ${month}월 ${day}일 (${weekday})`;
}

function displayFields(start, end, allDay, timeZone) {
  if (allDay) {
    // node-ical creates VALUE=DATE values at midnight in the host timezone.
    // Preserve those calendar components so Lambda UTC and local machines agree.
    const startDate = dateOnlyYmd(start);
    const endExclusive = dateOnlyYmd(end);
    const endDate = end > start ? shiftYmd(endExclusive, -1) : startDate;
    const displayDate = startDate === endDate
      ? koreanDateLabelFromYmd(startDate)
      : `${koreanDateLabelFromYmd(startDate)} ~ ${koreanDateLabelFromYmd(endDate)}`;
    return { displayDate, displayTime: "종일", displayText: `${displayDate} · 종일` };
  }

  const sameDate = localYmd(start, timeZone) === localYmd(end, timeZone);
  const displayDate = sameDate
    ? koreanDateLabel(start, timeZone)
    : `${koreanDateLabel(start, timeZone)} ~ ${koreanDateLabel(end, timeZone)}`;
  const displayTime = sameDate
    ? `${localHm(start, timeZone)}~${localHm(end, timeZone)}`
    : `${localDateTime(start, timeZone)} ~ ${localDateTime(end, timeZone)}`;
  return { displayDate, displayTime, displayText: `${displayDate} · ${displayTime}` };
}

function localMidnightUtc(year, month, day, timeZone) {
  const targetAsUtc = Date.UTC(year, month - 1, day);
  let guess = targetAsUtc;

  // Offset can change around DST boundaries. Two corrections converge for IANA zones.
  for (let i = 0; i < 3; i += 1) {
    const actual = partsAt(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = targetAsUtc - actualAsUtc;
    guess += correction;
    if (correction === 0) break;
  }

  return new Date(guess);
}

function localDateShift(parts, days) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function resolveCalendarRange({ range = "next_7_days", from, to, timeZone = "Asia/Seoul", now = new Date() } = {}) {
  if (from || to) {
    if (!from || !to) throw new Error("calendar from and to must be provided together");
    const start = new Date(from);
    const end = new Date(to);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
      throw new Error("calendar range is invalid");
    }
    return { from: start, to: end };
  }

  const local = partsAt(now, timeZone);
  if (range === "next_7_days") {
    return { from: now, to: new Date(now.getTime() + 7 * DAY_MS) };
  }
  if (range === "today") {
    const tomorrow = localDateShift(local, 1);
    return {
      from: localMidnightUtc(local.year, local.month, local.day, timeZone),
      to: localMidnightUtc(tomorrow.year, tomorrow.month, tomorrow.day, timeZone),
    };
  }
  if (range === "this_week") {
    const localStamp = Date.UTC(local.year, local.month - 1, local.day);
    const daysSinceMonday = (new Date(localStamp).getUTCDay() + 6) % 7;
    const monday = localDateShift(local, -daysSinceMonday);
    const nextMonday = localDateShift(monday, 7);
    return {
      from: localMidnightUtc(monday.year, monday.month, monday.day, timeZone),
      to: localMidnightUtc(nextMonday.year, nextMonday.month, nextMonday.day, timeZone),
    };
  }

  throw new Error(`unsupported calendar range: ${range}`);
}

function overlaps(start, end, from, to) {
  const eventEnd = end && end > start ? end : new Date(start.getTime() + 1);
  return start < to && eventEnd > from;
}

function cleanText(value, maxLength) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim().slice(0, maxLength);
}

function mapEvent(event, fallbackUid, recurring = Boolean(event.rrule), timeZone = "Asia/Seoul") {
  const start = event.start instanceof Date ? event.start : new Date(event.start);
  const end = event.end instanceof Date ? event.end : start;
  const allDay = Boolean(event.isFullDay ?? event.start?.dateOnly);
  const display = displayFields(start, end, allDay, timeZone);
  const title = cleanText(event.summary, 500) ?? "(제목 없음)";
  return {
    uid: String(event.uid ?? fallbackUid),
    title,
    start: start.toISOString(),
    end: end.toISOString(),
    startLocal: allDay ? dateOnlyYmd(start) : localDateTime(start, timeZone),
    endLocal: allDay ? dateOnlyYmd(end) : localDateTime(end, timeZone),
    timeZone,
    allDay,
    ...display,
    answerLine: `${title} — ${display.displayText}`,
    location: cleanText(event.location, 500),
    description: cleanText(event.description, 2_000),
    recurring,
  };
}

async function parseCalendarDocument(icsText, { from, to, limit = DEFAULT_LIMIT, timeZone = "Asia/Seoul" } = {}) {
  const parsed = await ical.async.parseICS(icsText);
  const events = [];
  let sourceEventCount = 0;
  const calendar = Object.values(parsed).find((component) => component?.type === "VCALENDAR");

  for (const [key, component] of Object.entries(parsed)) {
    if (component?.type !== "VEVENT" || !(component.start instanceof Date)) continue;
    sourceEventCount += 1;

    if (component.rrule) {
      const instances = ical.expandRecurringEvent(component, {
        from,
        to,
        includeOverrides: true,
        excludeExdates: true,
        expandOngoing: true,
      });
      for (const instance of instances) {
        const end = instance.end instanceof Date ? instance.end : instance.start;
        if (overlaps(instance.start, end, from, to)) {
          events.push(mapEvent(instance, `${key}#${instance.start.toISOString()}`, true, timeZone));
        }
      }
      continue;
    }

    const end = component.end instanceof Date ? component.end : component.start;
    if (overlaps(component.start, end, from, to)) {
      events.push(mapEvent(component, key, Boolean(component.rrule), timeZone));
    }
  }

  const sorted = events.sort((a, b) => a.start.localeCompare(b.start));
  return {
    calendarName: cleanText(calendar?.["WR-CALNAME"], 500),
    sourceEventCount,
    matchingEventCount: sorted.length,
    events: sorted.slice(0, Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)),
  };
}

export async function parseCalendarEvents(icsText, options = {}) {
  return (await parseCalendarDocument(icsText, options)).events;
}

export async function listPublicCalendarEvents({
  icsUrl,
  range,
  from,
  to,
  limit,
  timeZone = "Asia/Seoul",
  now = new Date(),
  fetchImpl = fetch,
} = {}) {
  const url = normalizeCalendarUrl(icsUrl);
  const resolved = resolveCalendarRange({ range, from, to, timeZone, now });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let currentUrl = url;
    let response;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      response = await fetchImpl(currentUrl, {
        headers: {
          accept: "text/calendar, text/plain;q=0.9, */*;q=0.1",
          "user-agent": "serverless-agent-day19/1.0",
        },
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.status < 300 || response.status >= 400) break;

      const location = response.headers.get("location");
      if (!location) throw new Error("calendar redirect is missing a location");
      currentUrl = normalizeCalendarUrl(new URL(location, currentUrl).toString());
      response = undefined;
    }
    if (!response) throw new Error("calendar redirected too many times");
    if (!response.ok) throw new Error(`calendar fetch failed (${response.status})`);

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_ICS_BYTES) throw new Error("calendar file is too large");

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_ICS_BYTES) throw new Error("calendar file is too large");

    const document = await parseCalendarDocument(text, { ...resolved, limit, timeZone });
    const warning = document.sourceEventCount === 0
      ? "The configured public calendar feed contains no VEVENT entries. Check that events were saved to this exact public calendar."
      : document.matchingEventCount === 0
        ? "The public calendar contains events, but none overlap the requested range."
        : undefined;

    return {
      calendarName: document.calendarName,
      timeZone,
      from: resolved.from.toISOString(),
      to: resolved.to.toISOString(),
      fromLocalDate: localYmd(resolved.from, timeZone),
      toLocalDateExclusive: localYmd(resolved.to, timeZone),
      sourceEventCount: document.sourceEventCount,
      matchingEventCount: document.matchingEventCount,
      count: document.events.length,
      events: document.events,
      warning,
    };
  } finally {
    clearTimeout(timer);
  }
}
