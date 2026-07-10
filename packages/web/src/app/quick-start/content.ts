// Quick start content — a short, screenshot-driven onboarding for new (consumer) users: the
// curated "first 10 minutes", not a replacement for the full user manual (built ad-hoc, outside
// this repo). Screenshots are served from packages/web/public/quickstart/ (captured and synced
// by e2e/shots.mjs). SKILLY_SPEC.md §8.
export interface QuickStartStep {
  kind: "intro" | "step" | "prereq" | "contribute" | "closing";
  /** Step number shown in the rail (steps only). */
  n?: number;
  title: string;
  lead: string;
  /** Optional supporting bullets. */
  points?: string[];
  /** Optional command shown in a mono block (the install step). */
  code?: string;
  /** Optional external links (e.g. official installer downloads) shown as buttons below the card. */
  links?: { label: string; href: string }[];
  /** Screenshot served from /quickstart/<file> (omit for intro/closing). */
  image?: string;
  alt?: string;
}

export const QUICK_START: QuickStartStep[] = [
  {
    kind: "intro",
    title: "Welcome to skilly",
    lead:
      "skilly is your organization's registry for agent skills — the SKILL.md packages that teach a coding agent how to do a task. This is the 10-minute tour: how to find a skill, install it into your agent, and keep it up to date. You can reopen this page any time from the account menu.",
  },
  {
    kind: "prereq",
    title: "If you're new to the AI skill game",
    lead:
      "Skills run on your own machine, not on skilly's servers. Before you install your first one, make sure two free tools are set up locally: Node.js (needed to run the npx skills add command in Step 3) and Python (many skills — including several in this very catalog — run Python scripts when you use them). Both take a few minutes to install.",
    points: [
      "Download the installer for your operating system — Windows, macOS, or Linux — using the links below. On Windows, choose the 64-bit (x64) version unless you know you need 32-bit.",
      "Run the downloaded installer and follow the prompts. On Windows, tick “Add python.exe to PATH” during the Python install so it works from the command line.",
      "Open a command line to check the install worked. Windows: press the Windows key, type “cmd” or “PowerShell”, and press Enter (or search “Windows Terminal”). macOS: press Cmd+Space, type “Terminal”, and press Enter (or find it in Applications → Utilities). Linux: open your terminal app from the applications menu (often Ctrl+Alt+T).",
      "Type the commands below and press Enter after each — each should print a version number. If nothing prints, close and reopen your terminal, or reinstall and make sure “Add to PATH” was checked.",
    ],
    code: "node -v\npython --version   (macOS/Linux: python3 --version)",
    links: [
      { label: "Download Node.js ↗", href: "https://nodejs.org/" },
      { label: "Download Python ↗", href: "https://www.python.org/downloads/" },
    ],
  },
  {
    kind: "step",
    n: 1,
    title: "Find a skill",
    lead:
      "Open the Catalog from the left sidebar to browse everything you have access to. Search by name or keyword (Ctrl+F jumps to the search box), or narrow the list with the filters.",
    points: [
      "Filter by category, tool/harness, or hosted-vs-pointer.",
      "Toggle between the card grid and a compact list — whichever you prefer.",
      "Skills that are new to you since your last visit are flagged with a “new” badge.",
    ],
    image: "/quickstart/find.png",
    alt: "The skilly catalog showing skill cards with search and filters",
  },
  {
    kind: "step",
    n: 2,
    title: "Open a skill",
    lead:
      "Click a skill to see its details: what it does, its full SKILL.md instructions, every published version, and its rating. Use “Show more” to read the complete SKILL.md inline.",
    points: [
      "Versions are immutable — a fix always ships as a new version.",
      "“Latest” is the highest stable version; you can also pin a specific one.",
      "Created and last-updated dates tell you how fresh the skill is.",
    ],
    image: "/quickstart/skill-detail.png",
    alt: "A skill detail page showing the SKILL.md, versions, and install box",
  },
  {
    kind: "step",
    n: 3,
    title: "Install it into your agent",
    lead:
      "On the skill's page, use the Install box to mint your personal install command (you choose how long it stays valid). Copy it and run it in your terminal — skilly serves the skill straight to your agent.",
    code: 'npx skills add "<paste your minted install command>"',
    points: [
      "Leave the version off to always pull the newest stable release on each re-clone.",
      "Add #v1.2.0 to pin a specific version that never moves.",
      "The command carries your own access token — don't share it.",
    ],
    image: "/quickstart/skill-detail.png",
    alt: "The install box on a skill page where you mint an install command",
  },
  {
    kind: "step",
    n: 4,
    title: "Manage what you've installed",
    lead:
      "Installed skills (in the account menu) lists everything you've added, newest first. From here you can re-copy a command, uninstall a skill, or reactivate one you removed.",
    image: "/quickstart/installed.png",
    alt: "The Installed skills page listing the user's installed skills",
  },
  {
    kind: "step",
    n: 5,
    title: "Stay in the loop",
    lead:
      "skilly tells you when something you care about changes. The bell shows notifications — for example when a new version of a skill you maintain or installed ships — and What's new lists every product change, newest first.",
    image: "/quickstart/notifications.png",
    alt: "The notifications page in skilly",
  },
  {
    kind: "contribute",
    title: "Want to contribute a skill?",
    lead:
      "Anyone can propose a skill. Use Propose a skill in the sidebar to upload a bundle or point at a git repo; a reviewer checks it (it's scanned automatically) and, once accepted, it's published to the catalog for everyone with access. The full lifecycle is in the User Manual.",
    image: "/quickstart/propose.png",
    alt: "The propose-a-skill form",
  },
  {
    kind: "closing",
    title: "That's the essentials",
    lead:
      "You're ready to go. Head to the catalog to find your first skill — and remember you can reopen this Quick start any time from the account menu. For the complete guide (contributing, reviewing, administration), ask your administrator for the skilly User Manual.",
  },
];
