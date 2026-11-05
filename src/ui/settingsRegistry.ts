/** Static navigation metadata only. Never add setting values, credentials or user content. */
export const SETTINGS_CATEGORIES = [
  {
    id: "general",
    label: "General",
    description: "Appearance, notifications, quick capture and dictation.",
  },
  {
    id: "providers-models",
    label: "Providers & models",
    description: "Connections, model choices and routing.",
  },
  {
    id: "personalization",
    label: "Personalization",
    description: "Instructions, memory and reusable prompts.",
  },
  {
    id: "costs-limits",
    label: "Costs & limits",
    description: "Budgets, spending caps and model prices.",
  },
  {
    id: "code-tools",
    label: "Code & tools",
    description: "Where code runs and the tools it can use.",
  },
  {
    id: "sync-devices",
    label: "Sync & devices",
    description: "Encrypted sync and connected devices.",
  },
  {
    id: "privacy-security",
    label: "Privacy & security",
    description: "Data permissions, app lock and recovery.",
  },
  {
    id: "data-storage",
    label: "Data & storage",
    description: "Import, export, backups and storage.",
  },
  {
    id: "about-diagnostics",
    label: "About & diagnostics",
    description: "Updates, request history and diagnostics.",
  },
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]["id"];
export type SettingsAvailability = "all" | "desktop" | "web";
interface ControlDefinition {
  id: string;
  label: string;
  description: string;
  aliases: readonly string[];
  selector?: string;
  availability?: SettingsAvailability;
}
interface SectionDefinition extends ControlDefinition {
  category: SettingsCategoryId;
  controls?: readonly ControlDefinition[];
}

export const SETTINGS_SECTIONS = [
  {
    id: "appearance",
    category: "general",
    label: "Appearance",
    description: "Theme, text size and motion.",
    aliases: ["display", "accessibility"],
    controls: [
      {
        id: "theme",
        label: "Theme",
        description: "Light, dark or system appearance.",
        aliases: ["dark mode", "light mode", "colour"],
        selector: '[aria-label="Theme"]',
      },
      {
        id: "text-size",
        label: "Text size",
        description: "Change the interface text size.",
        aliases: ["font", "zoom", "larger"],
        selector: '[aria-label="Text size"]',
        availability: "desktop",
      },
      {
        id: "motion",
        label: "Motion",
        description: "Reduce interface animations.",
        aliases: ["animation", "reduced motion"],
        selector: '[aria-label="Motion"]',
      },
    ],
  },
  {
    id: "notifications",
    category: "general",
    label: "Notifications",
    description: "Sounds, banners and system notifications.",
    aliases: ["alerts", "mute", "silence"],
    controls: [
      {
        id: "quiet-hours",
        label: "Quiet hours",
        description: "Choose quiet days and times.",
        aliases: ["do not disturb", "schedule"],
        selector: '[aria-label="Quiet hours"]',
      },
      {
        id: "notification-sound",
        label: "Notification sounds",
        description: "Play a sound with notifications.",
        aliases: ["chime", "mute", "sound"],
        selector: '[data-settings-control="notification-sound"]',
      },
      {
        id: "system-notifications",
        label: "System notifications",
        description: "Notifications for waiting runs, finished runs and budget alerts.",
        aliases: ["desktop alerts"],
        selector: '[data-settings-control="system-notifications"]',
      },
      {
        id: "notification-banners",
        label: "Banners in the app",
        description: "Update, routing, model, price, handoff and budget banners.",
        aliases: ["banner", "notices"],
        selector: '[data-settings-control="notification-banners"]',
      },
      {
        id: "quiet-days",
        label: "Quiet days",
        description: "Choose the days for quiet hours.",
        aliases: ["weekday", "weekend"],
        selector: '[aria-label="Quiet days"]',
      },
    ],
  },
  {
    id: "dictation",
    category: "general",
    label: "Dictation",
    description: "Microphone recording and consent to OpenAI audio transfer.",
    aliases: ["voice", "speech", "microphone", "transcription", "audio"],
    controls: [
      {
        id: "dictation-consent",
        label: "Dictation audio consent",
        description: "Enable audio transfer on this installation or browser.",
        aliases: ["recording", "cloud audio"],
        selector: '[data-settings-control="dictation-consent"]',
      },
    ],
  },
  {
    id: "quick-capture",
    category: "general",
    label: "Quick capture",
    description: "Capture a thought with a global shortcut.",
    aliases: ["hotkey", "keyboard"],
    availability: "desktop",
    controls: [
      {
        id: "capture-shortcut",
        label: "Quick capture shortcut",
        description: "Choose the global capture shortcut.",
        aliases: ["hotkey"],
        selector: '[aria-label="Quick capture shortcut"]',
        availability: "desktop",
      },
    ],
  },
  {
    id: "api-keys",
    category: "providers-models",
    label: "API keys",
    description: "Manage provider connections.",
    aliases: ["credentials", "connections"],
    controls: [
      {
        id: "openai-key",
        label: "OpenAI key",
        description: "Connect OpenAI models.",
        aliases: ["gpt", "api key"],
        selector: '[aria-label="OpenAI key"]',
      },
      {
        id: "anthropic-key",
        label: "Anthropic key",
        description: "Connect Claude models.",
        aliases: ["claude", "api key"],
        selector: '[aria-label="Anthropic key"]',
      },
    ],
  },
  {
    id: "models",
    category: "providers-models",
    label: "Models",
    description: "Check the catalog or add a model.",
    aliases: ["catalog", "available models", "missing models"],
  },
  {
    id: "model-defaults",
    category: "providers-models",
    label: "Model defaults",
    description: "Output limits, reasoning effort and prompt prefix.",
    aliases: ["tokens", "reasoning", "effort"],
    controls: [
      {
        id: "max-output-tokens",
        label: "Max output tokens",
        description: "Set the default maximum output length.",
        aliases: ["response length", "token limit"],
        selector: '[aria-label="Max output tokens"]',
      },
      {
        id: "reasoning-effort",
        label: "Reasoning effort",
        description: "Choose the default reasoning effort.",
        aliases: ["thinking", "low medium high"],
        selector: '[aria-label="Reasoning effort"]',
      },
      {
        id: "prompt-prefix",
        label: "Prompt prefix",
        description: "Set a prefix for model requests.",
        aliases: ["model instructions"],
        selector: '[aria-label="Prompt prefix"]',
      },
    ],
  },
  {
    id: "routing-policy",
    category: "providers-models",
    label: "Routing policy",
    description: "Model tiers, quality floor and provider preferences.",
    aliases: ["auto", "automatic", "rules", "quality"],
    controls: [
      {
        id: "routing-quality-floor",
        label: "Quality floor",
        description: "Choose the minimum routing tier.",
        aliases: ["routing quality", "balanced best"],
        selector: '[aria-label="Quality floor"]',
      },
      {
        id: "routing-provider-preference",
        label: "Provider preference",
        description: "Prefer a provider when routing.",
        aliases: ["preferred provider", "routing provider"],
        selector: '[aria-label="Provider preference"]',
      },
      {
        id: "routing-tiers",
        label: "Model tiers",
        description: "Choose the models assigned to each tier.",
        aliases: ["balanced", "best", "routing models"],
        selector: '[aria-label="Tiers"]',
      },
    ],
  },
  {
    id: "local-model",
    category: "providers-models",
    label: "Local model",
    description: "Install the optional on-device housekeeping helper.",
    aliases: ["offline", "download", "housekeeping"],
    availability: "desktop",
    controls: [
      {
        id: "local-housekeeping",
        label: "Local housekeeping",
        description: "Use the installed local model for housekeeping.",
        aliases: ["local helper", "local enabled"],
        selector: '[data-settings-control="local-housekeeping"]',
        availability: "desktop",
      },
    ],
  },
  {
    id: "instructions",
    category: "personalization",
    label: "Custom instructions",
    description: "Instructions that apply across chats.",
    aliases: ["system prompt", "preferences", "global"],
    controls: [
      {
        id: "about-you",
        label: "About you",
        description: "What every model should know about you.",
        aliases: ["custom instructions", "personal context"],
        selector: '[aria-label="About you"]',
      },
      {
        id: "how-to-answer",
        label: "How to answer",
        description: "Set tone, length and format for replies.",
        aliases: ["custom instructions", "writing style", "response style"],
        selector: '[aria-label="How to answer"]',
      },
    ],
  },
  {
    id: "memory",
    category: "personalization",
    label: "Memory",
    description: "Saved memories, suggestions and context limits.",
    aliases: ["remember", "forget", "facts", "context budget"],
    controls: [
      {
        id: "memory-suggestions",
        label: "Memory suggestions",
        description: "Suggest memories when leaving a chat.",
        aliases: ["remember automatically", "suggest memories"],
        selector: '[data-settings-control="memory-suggestions"]',
      },
      {
        id: "memory-budget",
        label: "Memory budget per message",
        description: "Limit tokens of memories included in each message.",
        aliases: ["memory limit", "memory tokens", "context budget"],
        selector: '[aria-label="Memory budget per message (tokens)"]',
      },
    ],
  },
  {
    id: "skills",
    category: "personalization",
    label: "Skills",
    description:
      "Import instruction packages and supporting files; invoke a pinned version by name.",
    aliases: ["skill packages", "SKILL.md", "named skills", "scripts"],
  },
  {
    id: "prompts",
    category: "personalization",
    label: "Prompt library",
    description: "Reusable prompts for recurring work.",
    aliases: ["templates", "slash commands"],
  },
  {
    id: "budgets",
    category: "costs-limits",
    label: "Budgets",
    description: "Budget limits and spending alerts.",
    aliases: ["spending", "money", "monthly budget", "hard stop"],
    controls: [
      {
        id: "budget-limit",
        label: "Budget limit",
        description: "Set a new budget limit in dollars.",
        aliases: ["spending limit", "money"],
        selector: '[aria-label="Budget limit in dollars"]',
      },
      {
        id: "budget-period",
        label: "Budget period",
        description: "Choose a daily or monthly budget.",
        aliases: ["daily budget", "monthly budget"],
        selector: '[aria-label="Budget period"]',
      },
      {
        id: "budget-hard-stop",
        label: "Hard stop",
        description: "Ask before sending after crossing the budget.",
        aliases: ["hard budget limit", "stop spending"],
        selector: '[data-settings-control="budget-hard-stop"]',
      },
    ],
  },
  {
    id: "key-caps",
    category: "costs-limits",
    label: "Spend caps per key",
    description: "Daily and monthly caps for provider keys.",
    aliases: ["spending", "limit", "api budget"],
    controls: [
      {
        id: "openai-daily-cap",
        label: "OpenAI daily cap",
        description: "Daily spending limit for the OpenAI key.",
        aliases: ["openai spending", "gpt cap"],
        selector: '[aria-label="OpenAI daily cap"]',
      },
      {
        id: "openai-monthly-cap",
        label: "OpenAI monthly cap",
        description: "Monthly spending limit for the OpenAI key.",
        aliases: ["openai spending", "gpt cap"],
        selector: '[aria-label="OpenAI monthly cap"]',
      },
      {
        id: "anthropic-daily-cap",
        label: "Anthropic daily cap",
        description: "Daily spending limit for the Anthropic key.",
        aliases: ["claude spending", "claude cap"],
        selector: '[aria-label="Anthropic daily cap"]',
      },
      {
        id: "anthropic-monthly-cap",
        label: "Anthropic monthly cap",
        description: "Monthly spending limit for the Anthropic key.",
        aliases: ["claude spending", "claude cap"],
        selector: '[aria-label="Anthropic monthly cap"]',
      },
    ],
  },
  {
    id: "prices",
    category: "costs-limits",
    label: "Model prices",
    description: "Pricing and when it was verified.",
    aliases: ["rates", "cost", "stale prices"],
  },
  {
    id: "hulk",
    category: "code-tools",
    label: "Run on HULK",
    description: "Pair this desktop with HULK for remote runs.",
    aliases: ["server", "pairing", "remote", "execution"],
    availability: "desktop",
  },
  {
    id: "sandbox",
    category: "code-tools",
    label: "Sandbox",
    description: "Sandbox configuration and folder permission reset.",
    aliases: ["Windows", "permissions", "commands"],
  },
  {
    id: "python",
    category: "code-tools",
    label: "Python runtime",
    description: "Manage Python for sandboxed data work.",
    aliases: ["install", "libraries", "data analysis"],
    availability: "desktop",
  },
  {
    id: "mcp",
    category: "code-tools",
    label: "MCP servers",
    description: "Connect tools and inspect server health.",
    aliases: ["integrations", "tools", "connectors", "oauth"],
  },
  {
    id: "connectors",
    category: "code-tools",
    label: "Connections",
    description: "Read OneDrive, Outlook Mail, Outlook Calendar and selected GitHub repositories.",
    aliases: [
      "Microsoft",
      "personal account",
      "work school",
      "OneDrive",
      "Outlook",
      "calendar",
      "mail",
      "GitHub",
      "device sign in",
      "accounts",
      "connectors",
      "disconnect",
    ],
  },
  {
    id: "sync",
    category: "sync-devices",
    label: "Encrypted sync",
    description: "Opt-in sync with HULK, progress and conflicts.",
    aliases: ["hulk", "synchronization", "pause", "sync now"],
    controls: [
      {
        id: "sync-devices",
        label: "Sync devices",
        description: "Devices participating in encrypted sync.",
        aliases: ["enrollment", "revoke"],
        selector: '[data-settings-control="sync-devices"]',
      },
      {
        id: "sync-recovery",
        label: "Sync recovery",
        description: "Recovery for encrypted sync.",
        aliases: ["recovery", "recovery code"],
        selector: '[data-settings-control="sync-recovery"]',
      },
    ],
  },
  {
    id: "server",
    category: "sync-devices",
    label: "FUSE on HULK",
    description: "Server devices and sign-out in the web app.",
    aliases: ["server", "devices", "pair device", "sign out"],
    availability: "web",
  },
  {
    id: "privacy",
    category: "privacy-security",
    label: "Provider permissions",
    description: "What leaves FUSE and which providers may receive data.",
    aliases: ["privacy", "egress", "sharing", "local only"],
  },
  {
    id: "app-lock",
    category: "privacy-security",
    label: "App lock",
    description: "Passcode, idle lock and biometric access.",
    aliases: ["password", "security", "Windows Hello"],
    availability: "desktop",
  },
  {
    id: "database-recovery",
    category: "privacy-security",
    label: "Database recovery key",
    description: "Recover the local database if its keychain key is lost.",
    aliases: ["recovery", "encryption", "password manager"],
    availability: "desktop",
  },
  {
    id: "import",
    category: "data-storage",
    label: "Import conversations",
    description: "Import conversations from ChatGPT and Claude.",
    aliases: ["history", "migration", "paste"],
  },
  {
    id: "data",
    category: "data-storage",
    label: "Your data",
    description: "Export, back up, restore, check storage or delete data.",
    aliases: ["download", "backup", "restore", "storage", "cleanup", "delete"],
    controls: [
      {
        id: "backups",
        label: "Backups",
        description: "Back up now or restore a saved backup.",
        aliases: ["backup", "recovery", "restore"],
        selector: '[aria-label="Backups"]',
      },
      {
        id: "storage",
        label: "Storage & cleanup",
        description: "Disk usage and safe cleanup options.",
        aliases: ["space", "cache", "storage"],
        selector: '[aria-label="Storage"]',
      },
      {
        id: "restore-export",
        label: "Restore from an export",
        description: "Restore a portable export.",
        aliases: ["restore", "zip", "import"],
        selector: '[aria-label="Restore from an export"]',
      },
    ],
  },
  {
    id: "version",
    category: "about-diagnostics",
    label: "Version & updates",
    description: "Installed version and update checks.",
    aliases: ["upgrade", "release", "about"],
  },
  {
    id: "request-log",
    category: "about-diagnostics",
    label: "Request log",
    description: "Provider calls, tokens, cost, latency and errors.",
    aliases: ["debug", "logs", "history", "diagnostics"],
  },
  {
    id: "agent-activity",
    category: "about-diagnostics",
    label: "Coding agent activity",
    description: "Review or export coding tool activity.",
    aliases: ["audit", "history", "tools"],
  },
  {
    id: "routing-diagnostics",
    category: "about-diagnostics",
    label: "Routing test set",
    description: "Evaluate routing against the golden test set.",
    aliases: ["golden", "evaluation", "debug", "diagnostics"],
  },
] as const satisfies readonly SectionDefinition[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
type Section = (typeof SETTINGS_SECTIONS)[number];
type Controls<S> = S extends { controls: readonly (infer C)[] } ? C : never;
export type SettingsTargetId = SettingsSectionId | Controls<Section>["id"];
export interface SettingsTarget extends ControlDefinition {
  id: SettingsTargetId;
  category: SettingsCategoryId;
  section: SettingsSectionId;
}

export const SETTINGS_TARGETS: readonly SettingsTarget[] = SETTINGS_SECTIONS.flatMap(
  (section): SettingsTarget[] => [
    { ...section, section: section.id },
    ...("controls" in section ? section.controls : []).map((control) => ({
      ...control,
      category: section.category,
      section: section.id,
    })),
  ],
);

export function settingsTarget(id: string): SettingsTarget | undefined {
  return SETTINGS_TARGETS.find((target) => target.id === id);
}
