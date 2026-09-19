// Catalog snapshots are bundled by Vite, never fetched or executed at runtime.
import type { SkillId } from "./catalog";
import skill0 from "./skills/airbnb.com/search-listings-ddgioa/SKILL.md?raw";
import skill1 from "./skills/alltrails.com/search-trails-dsqvnx/SKILL.md?raw";
import skill2 from "./skills/doordash.com/extract-menu-5uzqvc/SKILL.md?raw";
import skill3 from "./skills/facebook.com/search-marketplace-m9gyrc/SKILL.md?raw";
import skill4 from "./skills/link.com/create-payment-credential-0nc34a/SKILL.md?raw";
import skill5 from "./skills/luma.com/discover-1zqc5a/SKILL.md?raw";
import skill6 from "./skills/opentable.com/check-availability-f2fwrm/SKILL.md?raw";
import skill7 from "./skills/skyscanner.net/search-cheapest-flight-v8nvut/SKILL.md?raw";
import skill8 from "./skills/ticketmaster.com/find-ticket-i7c0vy/SKILL.md?raw";
import skill9 from "./skills/yelp.com/find-menu-jhjk4o/SKILL.md?raw";
export const instructions: Record<SkillId, string> = {
  "airbnb.com/search-listings-ddgioa": skill0,
  "alltrails.com/search-trails-dsqvnx": skill1,
  "doordash.com/extract-menu-5uzqvc": skill2,
  "facebook.com/search-marketplace-m9gyrc": skill3,
  "link.com/create-payment-credential-0nc34a": skill4,
  "luma.com/discover-1zqc5a": skill5,
  "opentable.com/check-availability-f2fwrm": skill6,
  "skyscanner.net/search-cheapest-flight-v8nvut": skill7,
  "ticketmaster.com/find-ticket-i7c0vy": skill8,
  "yelp.com/find-menu-jhjk4o": skill9,
};
