/**
 * What the clinic sees to pick its CRM, and the step-by-step help behind each
 * card's "How to find …" button.
 *
 * Steps follow each vendor's own help pages (linked as `source`). Mindbody's
 * client export has no official page we could find, so its steps come from
 * integration guides and say menus can differ. A step can show a menu path as
 * chips and a screenshot (`image`, kept under /public/crm/guides).
 */
import type { CrmProvider } from "./types";

/**
 * Logos are the vendors' own, used only to show which CRM is which. `size` evens
 * out how big they look (Aesthetic Record's has small lettering).
 */
export const CRM_LOGOS: Record<CrmProvider, { src: string; width: number; height: number; size: string }> = {
  zenoti: { src: "/crm/zenoti.svg", width: 111, height: 31, size: "h-7 max-w-[160px]" },
  mindbody: { src: "/crm/mindbody.svg", width: 912, height: 191, size: "h-7 max-w-[160px]" },
  aesthetic_record: { src: "/crm/aesthetic-record.png", width: 250, height: 58, size: "h-10 max-w-[190px]" },
};

export type GuideStep = {
  text: string;
  /** Menus to click through, shown as chips, e.g. Configuration › Integrations › Apps. */
  path?: string[];
  image?: { src: string; alt: string };
};

export type CrmGuide = {
  /** The button next to the CRM's name. */
  button: string;
  title: string;
  intro: string;
  steps: GuideStep[];
  note?: string;
  source?: { label: string; url: string };
};

const ZENOTI: CrmGuide = {
  button: "How to find your API key",
  title: "Find your Zenoti API key",
  intro: "About 5 minutes. Use a Zenoti login with owner access.",
  steps: [
    { text: "Log in to Zenoti at the organization level, not inside one center." },
    {
      text: "Click the Configuration icon, search for Apps, and open Apps under Integrations.",
      path: ["Configuration", "Integrations", "Apps"],
    },
    { text: "On the Manage Applications page, click Add." },
    { text: "Name the app RevOS. Set Login User Type to Employee and Source App to Client App, leave URI blank, and click Next." },
    { text: "In the APIKEY Groups column, tick the groups for guests and centers (Select All works too), then click Next." },
    { text: "Click Generate API Key and copy the key. Then click Finish." },
    { text: "Paste the key here and click Connect Zenoti. If you have more than one center, pick the one these leads are for." },
  ],
  note: "Zenoti keys expire after a set time. If RevOS says the key stopped working, make a new one the same way and paste it here.",
  source: { label: "Zenoti's own guide", url: "https://docs.zenoti.com/docs/create-the-backend-app-and-generate-a-new-api-key-1" },
};

const MINDBODY_CONNECT: CrmGuide = {
  button: "How to find your Site ID",
  title: "Connect Mindbody",
  intro: "The Mindbody account owner does the approval step.",
  steps: [
    { text: "Log in to Mindbody. Your Site ID is the number at the bottom of the page (it may say Studio ID). Clicking your name at the top right shows it too." },
    { text: "Type the Site ID here and click Connect Mindbody." },
    {
      text: "RevOS shows an approval link and a code. The owner opens the link, or goes to Manager Tools, then Mindbody Add-Ons, then API Integrations, and enters the code.",
      path: ["Manager Tools", "Mindbody Add-Ons", "API Integrations"],
    },
    { text: "Back here, click I approved it. Your clients start coming in." },
  ],
  note: "Only the owner login can see API Integrations. A Site ID with two digits swapped is the most common reason a code doesn't work.",
};

const MINDBODY_EXPORT: CrmGuide = {
  button: "How to export your clients",
  title: "Export your clients from Mindbody",
  intro: "Until Mindbody connects, upload a client export instead. It takes a couple of minutes.",
  steps: [
    { text: "Log in to Mindbody and open Reports, then Clients.", path: ["Reports", "Clients"] },
    { text: "Pick the client list report (it may be called Email List or Mailing List) and choose All clients." },
    { text: "Click Generate, then export it to Excel." },
    { text: "Upload that file on this page, under the spreadsheet upload." },
  ],
  note: "Menu names can differ by Mindbody plan. If you can't find it, Mindbody support can send you a client export.",
};

const AESTHETIC_RECORD: CrmGuide = {
  button: "How to export your client list",
  title: "Export your patient list from Aesthetic Record",
  intro: "Do this on a computer. It takes a couple of minutes.",
  steps: [
    { text: "Log in to Aesthetic Record and open Patients (some accounts call it Clients).", path: ["Patients"] },
    { text: "Click + and tick the columns to include: first name, last name, phone and email." },
    { text: "Click Import/Export, then Export as Excel.", path: ["Import/Export", "Export as Excel"] },
    { text: "The file downloads to your computer. Upload it on this page, under the spreadsheet upload." },
  ],
  note: "Nothing downloading? Allow pop-ups for Aesthetic Record and try again.",
  source: { label: "Aesthetic Record's own guide", url: "https://learn.aestheticrecord.com/en/articles/9251301-import-or-export-your-patient-list" },
};

/** The help for a card. Mindbody shows its export steps until it can be connected. */
export function guideFor(provider: CrmProvider, available: boolean): CrmGuide {
  if (provider === "zenoti") return ZENOTI;
  if (provider === "mindbody") return available ? MINDBODY_CONNECT : MINDBODY_EXPORT;
  return AESTHETIC_RECORD;
}

/** One line under each logo on the "which CRM do you use?" tiles. */
export function pickerHint(provider: CrmProvider, available: boolean): string {
  if (provider === "zenoti") return "Paste an API key from Zenoti.";
  if (provider === "mindbody") return available ? "The owner approves RevOS in Mindbody." : "Coming soon. Upload a file for now.";
  return "Export your list to Excel and upload it.";
}
