// Keyword sector tags (plan D1). Computed at export time, never stored: items carry the short ids
// ("sectors": ["ai", "fintech"]), stats.json carries the labels once. Every rule is a case-insensitive
// word-boundary regex, so "rain" is not AI and "email" is not ML. Displayed as "keyword-tagged".

export const SECTORS = [
  { id: 'ai', label: 'AI/ML', re: /\b(ai|a\.i\.|llms?|gen(erative)? ai|machine learning|deep learning|ml|agentic|agents?|copilots?|gpt|neural|chatbots?|computer vision|nlp|foundation models?)\b/i },
  { id: 'fintech', label: 'Fintech', re: /\b(fintech|payments?|lending|loans?|neobank|banking|banks?|insurtech|insurance|wallets?|remittances?|credit|bnpl|treasury|payroll|invoic(e|es|ing)|accounting|crypto|stablecoins?|defi|trading)\b/i },
  { id: 'health', label: 'Health & Bio', re: /\b(health(care|tech)?|medical|medtech|biotech|bio|clinic(al|s)?|hospitals?|patients?|pharma(ceuticals?)?|drug|therap(y|ies|eutics)|diagnostics?|mental health|telehealth|wellness|genomics?|dental|fitness)\b/i },
  { id: 'climate', label: 'Climate & Energy', re: /\b(climate(tech)?|clean ?tech|carbon|decarboni[sz](e|ation)|solar|wind|batter(y|ies)|energy|ev|evs|charging|hydrogen|renewables?|sustainab(le|ility)|emissions?|nuclear|fusion|geothermal)\b/i },
  { id: 'devtools', label: 'Devtools & Infra', re: /\b(developers?|dev ?tools?|api|apis|sdks?|open[- ]source|cli|infra(structure)?|cloud|kubernetes|k8s|docker|databases?|postgres|sql|observability|ci\/cd|devops|serverless|compilers?|terminal|ide|github|rust|python|javascript|typescript)\b/i },
  { id: 'security', label: 'Security', re: /\b(cyber(security)?|security|infosec|zero[- ]trust|identity|authentication|auth|passwordless|encryption|encrypted|privacy|compliance|soc ?2|fraud|phishing|vulnerabilit(y|ies)|pentest(ing)?|malware)\b/i },
  { id: 'edtech', label: 'Edtech', re: /\b(edtech|education|learning platform|e-learning|students?|schools?|universit(y|ies)|tutor(s|ing)?|courses?|upskilling|teachers?|classroom|k-12|mooc)\b/i },
  { id: 'commerce', label: 'Marketplace & Commerce', re: /\b(marketplaces?|e-?commerce|retail(ers)?|shop(ping|ify)?|stores?|d2c|dtc|b2b marketplace|sellers?|merchants?|checkout|grocery|wholesale|quick commerce)\b/i },
  { id: 'saas', label: 'SaaS & Productivity', re: /\b(saas|productivity|workflows?|automation|no[- ]code|low[- ]code|crm|hr ?tech|hiring|recruit(ing|ment)|spreadsheets?|dashboards?|collaboration|project management|b2b software|erp)\b/i },
  { id: 'hardware', label: 'Hardware & Robotics', re: /\b(hardware|robots?|robotics|humanoids?|drones?|sensors?|chips?|semiconductors?|gpus?|wearables?|iot|3d print(ing|ers?)|manufacturing|factor(y|ies)|devices?)\b/i },
  { id: 'mobility', label: 'Mobility & Logistics', re: /\b(mobility|logistics|delivery|deliveries|fleet|freight|shipping|supply chain|trucking|ride[- ]?hailing|autonomous (vehicles?|driving)|self-driving|scooters?|warehous(e|es|ing)|last[- ]mile|transport(ation)?)\b/i },
  { id: 'media', label: 'Media & Creator', re: /\b(media|creators?|creator economy|podcasts?|newsletters?|video|videos|streaming|music|publishing|journalism|influencers?|youtube|tiktok|film|photo(graphy|s)?)\b/i },
  { id: 'consumer', label: 'Consumer & Social', re: /\b(consumers?|social (network|app|media)|dating|social app|messaging|chat app|lifestyle|travel|food|restaurants?|parenting|pets?|fashion|beauty)\b/i },
  { id: 'gaming', label: 'Gaming', re: /\b(gaming|games?|gamers?|esports|game (studio|engine|dev)|unity|unreal|roblox|steam|playstation|xbox|nintendo|metaverse)\b/i },
  { id: 'space', label: 'Space & Defense', re: /\b(space(tech)?|satellites?|rockets?|launch vehicles?|orbit(al)?|aerospace|defen[cs]e|military|spacex|nasa|isro|lunar|mars)\b/i },
];

/** id -> label, table order. */
export const SECTOR_LABELS = Object.fromEntries(SECTORS.map((s) => [s.id, s.label]));

export function sectorLabel(id) {
  return SECTOR_LABELS[id] ?? String(id ?? '');
}

/** Unique sector ids in table order for the given text; [] when nothing matches. */
export function tagSectors(title, summary = '') {
  const haystack = `${title ?? ''} ${summary ?? ''}`;
  const out = [];
  for (const s of SECTORS) {
    if (s.re.test(haystack)) out.push(s.id);
  }
  return out;
}
