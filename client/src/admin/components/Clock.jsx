/**
 * The wall clock in the top bar.
 *
 * It is here because this dashboard is used on a shared workstation on a
 * packing floor, where the person reading it is often recording a time - a
 * batch released, a shipment sealed, an alert acknowledged - and the machine's
 * own clock is not on screen in a kiosk browser.
 *
 * TICKS ONCE A MINUTE, ALIGNED TO THE MINUTE. The display has no seconds, so a
 * one-second interval would re-render sixty times for fifty-nine identical
 * frames. A plain 60-second interval is worse than it looks: it starts
 * whenever the dashboard happened to load, so the reading can sit up to 59
 * seconds stale - long enough to write down the wrong minute. Instead each
 * tick schedules the next one for the top of the following minute.
 *
 * Everything is formatted in the BROWSER'S locale and time zone. A time shown
 * on this screen should match the clock on the wall beside it; a server-side
 * or fixed-locale rendering would not.
 */
import { useEffect, useState } from 'react';

/** Milliseconds until the start of the next minute. */
const untilNextMinute = (now) => 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());

export default function Clock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer;

    function schedule() {
      timer = setTimeout(() => {
        // A wake from sleep can fire this late, so read the clock rather than
        // adding a minute to the last value.
        const current = new Date();
        setNow(current);
        schedule();
      }, untilNextMinute(new Date()));
    }

    schedule();
    return () => clearTimeout(timer);
  }, []);

  const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const date = now.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    // `dateTime` carries the unambiguous value; the two lines are decoration
    // around it. `aria-hidden` on the date keeps a screen reader from reading
    // the same instant twice.
    <time className="shell-clock" dateTime={now.toISOString()}>
      <strong>{time}</strong>
      <span aria-hidden="true">{date}</span>
    </time>
  );
}
