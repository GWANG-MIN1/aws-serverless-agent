import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  listPublicCalendarEvents,
  normalizeCalendarUrl,
  resolveCalendarRange,
} from "../lambda/calendar.mjs";

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Day19 Test//EN
BEGIN:VEVENT
UID:single@example.com
DTSTAMP:20260601T000000Z
DTSTART;TZID=Asia/Seoul:20260609T140000
DTEND;TZID=Asia/Seoul:20260609T150000
SUMMARY:팀 회의
LOCATION:회의실 A
END:VEVENT
BEGIN:VEVENT
UID:daily@example.com
DTSTAMP:20260601T000000Z
DTSTART;TZID=Asia/Seoul:20260608T090000
DTEND;TZID=Asia/Seoul:20260608T093000
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:아침 체크인
END:VEVENT
END:VCALENDAR`;

const DISPLAY_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Day19 Display Test//EN
BEGIN:VEVENT
UID:all-day@example.com
DTSTART;VALUE=DATE:20260618
DTEND;VALUE=DATE:20260619
SUMMARY:랩 미팅
END:VEVENT
BEGIN:VEVENT
UID:midnight@example.com
DTSTART;TZID=Asia/Seoul:20260619T000000
DTEND;TZID=Asia/Seoul:20260619T010000
SUMMARY:운동
END:VEVENT
END:VCALENDAR`;

test("normalizes webcal iCloud URLs and rejects arbitrary hosts", () => {
  assert.equal(
    normalizeCalendarUrl("webcal://p01-caldav.icloud.com/published/2/example"),
    "https://p01-caldav.icloud.com/published/2/example",
  );
  assert.throws(() => normalizeCalendarUrl("https://example.com/calendar.ics"), /iCloud/);
  assert.throws(() => normalizeCalendarUrl("http://p01-caldav.icloud.com/calendar.ics"), /https/);
});

test("resolves this week in the configured timezone", () => {
  const result = resolveCalendarRange({
    range: "this_week",
    timeZone: "Asia/Seoul",
    now: new Date("2026-06-10T13:00:00.000Z"),
  });
  assert.equal(result.from.toISOString(), "2026-06-07T15:00:00.000Z");
  assert.equal(result.to.toISOString(), "2026-06-14T15:00:00.000Z");
});

test("fetches, expands recurring events, and returns sorted read-only data", async () => {
  const result = await listPublicCalendarEvents({
    icsUrl: "webcal://p01-caldav.icloud.com/published/2/example",
    range: "this_week",
    timeZone: "Asia/Seoul",
    now: new Date("2026-06-10T13:00:00.000Z"),
    fetchImpl: async () => new Response(ICS, {
      status: 200,
      headers: { "content-type": "text/calendar" },
    }),
  });

  assert.equal(result.count, 4);
  assert.equal(result.sourceEventCount, 2);
  assert.equal(result.matchingEventCount, 4);
  assert.equal(result.fromLocalDate, "2026-06-08");
  assert.equal(result.toLocalDateExclusive, "2026-06-15");
  assert.deepEqual(
    result.events.map((event) => event.title),
    ["아침 체크인", "아침 체크인", "팀 회의", "아침 체크인"],
  );
  assert.equal(result.events[0].start, "2026-06-08T00:00:00.000Z");
  assert.equal(result.events[0].startLocal, "2026-06-08T09:00:00");
  assert.equal(result.events[0].endLocal, "2026-06-08T09:30:00");
  assert.equal(result.events[0].timeZone, "Asia/Seoul");
  assert.equal(result.events[0].recurring, true);
  assert.equal(result.events[2].location, "회의실 A");
  assert.equal(result.warning, undefined);
});

test("rejects redirects that leave iCloud", async () => {
  await assert.rejects(
    listPublicCalendarEvents({
      icsUrl: "https://p01-caldav.icloud.com/published/2/example",
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    }),
    /https|iCloud/,
  );
});

test("distinguishes an empty public feed from an empty requested range", async () => {
  const emptyFeed = `BEGIN:VCALENDAR
VERSION:2.0
X-WR-CALNAME:Day 19 test
END:VCALENDAR`;
  const result = await listPublicCalendarEvents({
    icsUrl: "https://p01-caldav.icloud.com/published/2/example",
    range: "this_week",
    timeZone: "Asia/Seoul",
    now: new Date("2026-06-10T13:00:00.000Z"),
    fetchImpl: async () => new Response(emptyFeed, { status: 200 }),
  });

  assert.equal(result.calendarName, "Day 19 test");
  assert.equal(result.sourceEventCount, 0);
  assert.equal(result.matchingEventCount, 0);
  assert.match(result.warning, /exact public calendar/);
});

test("preformats Korean weekdays, midnight times, and exclusive all-day ends", async () => {
  const result = await listPublicCalendarEvents({
    icsUrl: "https://p01-caldav.icloud.com/published/2/example",
    from: "2026-06-18T00:00:00+09:00",
    to: "2026-06-20T00:00:00+09:00",
    timeZone: "Asia/Seoul",
    fetchImpl: async () => new Response(DISPLAY_ICS, { status: 200 }),
  });

  assert.equal(result.count, 2);
  assert.deepEqual(
    result.events.map(({ title, displayDate, displayTime, displayText, answerLine }) => ({
      title,
      displayDate,
      displayTime,
      displayText,
      answerLine,
    })),
    [
      {
        title: "랩 미팅",
        displayDate: "2026년 6월 18일 (목)",
        displayTime: "종일",
        displayText: "2026년 6월 18일 (목) · 종일",
        answerLine: "랩 미팅 — 2026년 6월 18일 (목) · 종일",
      },
      {
        title: "운동",
        displayDate: "2026년 6월 19일 (금)",
        displayTime: "00:00~01:00",
        displayText: "2026년 6월 19일 (금) · 00:00~01:00",
        answerLine: "운동 — 2026년 6월 19일 (금) · 00:00~01:00",
      },
    ],
  );
});

test("keeps all-day calendar dates unchanged in a UTC Lambda runtime", () => {
  const moduleUrl = new URL("../lambda/calendar.mjs", import.meta.url).href;
  const script = `
    import { parseCalendarEvents } from ${JSON.stringify(moduleUrl)};
    const events = await parseCalendarEvents(${JSON.stringify(DISPLAY_ICS)}, {
      from: new Date("2026-06-17T15:00:00.000Z"),
      to: new Date("2026-06-19T15:00:00.000Z"),
      timeZone: "Asia/Seoul",
    });
    process.stdout.write(JSON.stringify(events.map((event) => ({
      title: event.title,
      startLocal: event.startLocal,
      endLocal: event.endLocal,
      answerLine: event.answerLine,
    }))));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
  });

  assert.deepEqual(JSON.parse(output), [
    {
      title: "랩 미팅",
      startLocal: "2026-06-18",
      endLocal: "2026-06-19",
      answerLine: "랩 미팅 — 2026년 6월 18일 (목) · 종일",
    },
    {
      title: "운동",
      startLocal: "2026-06-19T00:00:00",
      endLocal: "2026-06-19T01:00:00",
      answerLine: "운동 — 2026년 6월 19일 (금) · 00:00~01:00",
    },
  ]);
});
