// Daily Brief shared types.

export type CalendarEvent = {
  title: string;
  start_local: string;   // "09:30"
  end_local?: string;    // "10:30"
  location?: string;
  attendees_count?: number;
};

export type UrgentEmail = {
  from: string;          // "Sarah Chen"
  subject: string;
  snippet: string;       // first ~80 chars
};

export type WeatherSnapshot = {
  high_f: number;
  low_f: number;
  precip_probability: number; // 0..1
  conditions: string;         // "Partly cloudy"
};

export type FeedHeadline = {
  source: string;        // "Hacker News"
  title: string;
  url: string;
};

export type DailyBrief = {
  generated_at: string;  // ISO
  date_local: string;    // "2026-05-16"
  events: CalendarEvent[];
  urgent_emails: UrgentEmail[];
  weather: WeatherSnapshot | null;
  feeds: FeedHeadline[];
  warnings: string[];    // sources that failed; never blocks delivery
};

export type DeliveryResult = {
  ok: boolean;
  channel: "telegram" | "stdout";
  message_id?: number;
  error?: string;
};
