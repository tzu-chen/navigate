import { useState, useEffect } from 'react';
import Icon from './Icon';

/**
 * arXiv announces new submissions at 20:00 ET (8 PM Eastern),
 * Sunday through Thursday. No announcements on Friday or Saturday.
 * See: https://info.arxiv.org/help/availability.html
 */

const ANNOUNCEMENT_HOUR = 20; // 20:00 ET
const ANNOUNCEMENT_DAYS = new Set([0, 1, 2, 3, 4]); // Sun=0 through Thu=4

const DAY_NAMES: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function getSecondsUntilNextRefresh(): number {
  const now = new Date();

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find(p => p.type === 'weekday')?.value || 'Mon';
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
  const second = parseInt(parts.find(p => p.type === 'second')?.value || '0');

  const currentDay = DAY_NAMES[weekday] ?? 1;
  const currentSeconds = hour * 3600 + minute * 60 + second;
  const targetSeconds = ANNOUNCEMENT_HOUR * 3600;
  const isBeforeAnnouncement = currentSeconds < targetSeconds;

  let daysUntil: number;
  if (ANNOUNCEMENT_DAYS.has(currentDay) && isBeforeAnnouncement) {
    daysUntil = 0;
  } else {
    let next = (currentDay + 1) % 7;
    daysUntil = 1;
    while (!ANNOUNCEMENT_DAYS.has(next)) {
      next = (next + 1) % 7;
      daysUntil++;
    }
  }

  return daysUntil * 86400 + (targetSeconds - currentSeconds);
}

function formatCountdown(totalSeconds: number): string {
  if (totalSeconds <= 0) return 'Now';

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

export default function ArxivRefreshTimer() {
  const [secondsLeft, setSecondsLeft] = useState(() => getSecondsUntilNextRefresh());

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft(getSecondsUntilNextRefresh());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="arxiv-refresh-timer" title="Time until next arXiv announcement (20:00 ET, Sun–Thu)">
      <span className="arxiv-refresh-icon"><Icon name="refresh" /></span>
      <span className="arxiv-refresh-label">arXiv</span>
      <span className="arxiv-refresh-countdown">{formatCountdown(secondsLeft)}</span>
    </div>
  );
}
