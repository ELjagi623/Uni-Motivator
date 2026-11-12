import ICAL from 'ical.js';

/** All VEVENTs that share one UID: the master (may be absent) and its RECURRENCE-ID exceptions. */
export interface EventGroup {
  uid: string;
  /** The recurring/one-off master event, or null when only orphan exceptions exist. */
  master: ICAL.Event | null;
  /** Exceptions that could not be attached to a master (no master in the file); treated as stand-alone events. */
  orphans: ICAL.Event[];
}

export interface ParsedCalendar {
  vtimezones: ICAL.Component[];
  groups: EventGroup[];
}

export class IcsParseError extends Error {
  constructor() {
    // Never echo calendar content in the message: the text may be private.
    super('The calendar data is not valid iCalendar text.');
    this.name = 'IcsParseError';
  }
}

function topLevelComponents(text: string): ICAL.Component[] {
  let jcal: unknown;
  try {
    jcal = ICAL.parse(text);
  } catch {
    throw new IcsParseError();
  }
  if (!Array.isArray(jcal)) throw new IcsParseError();
  // ICAL.parse returns one jCal array for a single VCALENDAR and an array of them for several.
  const list = Array.isArray(jcal[0]) ? (jcal as unknown[][]) : [jcal as unknown[]];
  return list.map((j) => new ICAL.Component(j as never));
}

/**
 * Parse iCalendar text: collect VTIMEZONEs and group VEVENTs by UID, attaching RECURRENCE-ID exceptions to
 * their master with `relateException`. Time zones are registered later, per calendar, by `expandCalendar`
 * (the ical.js timezone registry is global, so it must be filled right before use).
 */
export function parseIcs(text: string): ParsedCalendar {
  const vtimezones: ICAL.Component[] = [];
  const masters: { uid: string; event: ICAL.Event }[] = [];
  const exceptions: ICAL.Event[] = [];

  for (const cal of topLevelComponents(text)) {
    if (cal.name !== 'vcalendar') continue;
    vtimezones.push(...cal.getAllSubcomponents('vtimezone'));
    for (const ve of cal.getAllSubcomponents('vevent')) {
      const event = new ICAL.Event(ve);
      if (!event.uid) continue;
      if (ve.hasProperty('recurrence-id')) exceptions.push(event);
      else masters.push({ uid: event.uid, event });
    }
  }

  const groups: EventGroup[] = [];
  const byUid = new Map<string, EventGroup>();
  for (const { uid, event } of masters) {
    const group: EventGroup = { uid, master: event, orphans: [] };
    groups.push(group);
    if (!byUid.has(uid)) byUid.set(uid, group);
  }
  for (const ex of exceptions) {
    const group = byUid.get(ex.uid);
    if (group && group.master) {
      group.master.relateException(ex);
    } else {
      const orphanGroup: EventGroup = { uid: ex.uid, master: null, orphans: [ex] };
      groups.push(orphanGroup);
    }
  }
  return { vtimezones, groups };
}
