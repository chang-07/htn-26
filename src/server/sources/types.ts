/**
 * What each source returns. Display strings are already formatted for the
 * chat ("CA$254", "$277"); times for flights are the local wall-clock text
 * Google shows, and epoch seconds for FlightAware, which knows the zone.
 */
export type Flight = {
  price: string;
  currency: string;
  airline: string;
  from: string;
  to: string;
  departs: string;
  arrives: string;
  date: string;
  duration: string;
  stops: number;
  layover?: string;
  roundTrip?: boolean;
  nextDay: boolean;
  url: string;
};

export type Stay = {
  name: string;
  nightly: string;
  rating?: number;
  reviews?: number;
  url: string;
};

export type Event = {
  title: string;
  when: string;
  venue?: string;
  city?: string;
  url: string;
  onsale?: string;
  soldOut?: boolean;
  limited?: boolean;
  source: "ticketmaster" | "luma";
};

export type FlightStatus = {
  ident: string;
  iata: string;
  status: "scheduled" | "departed" | "landed" | "cancelled" | "unknown";
  from: string;
  to: string;
  fromTz?: string;
  toTz?: string;
  gateFrom?: string;
  terminalFrom?: string;
  gateTo?: string;
  terminalTo?: string;
  scheduledDeparture: number;
  estimatedDeparture?: number;
  actualDeparture?: number;
  scheduledArrival: number;
  estimatedArrival?: number;
  actualArrival?: number;
  delayMinutes: number;
  url: string;
};

export type OrderStatus = {
  fulfilled: boolean;
  delivered: boolean;
  carrier?: string;
  tracking?: string;
  trackingUrl?: string;
  eta?: string;
};
