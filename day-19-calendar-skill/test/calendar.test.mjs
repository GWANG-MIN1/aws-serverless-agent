import test from "node:test";
import assert from "node:assert/strict";

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
  assert.deepEqual(
    result.events.map((event) => event.title),
    ["아침 체크인", "아침 체크인", "팀 회의", "아침 체크인"],
  );
  assert.equal(result.events[0].start, "2026-06-08T00:00:00.000Z");
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
