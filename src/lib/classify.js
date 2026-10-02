export const KINDS = ['launch', 'funding', 'news', 'accelerator'];
export const REGIONS = ['usa', 'europe', 'asia', 'india', 'latam', 'africa', 'global'];

export const FUNDING_RE = /\b(raises|raised|secures|closes|lands|bags|nabs)\b.*\$|\b(seed|pre-seed|series [a-h]|funding round|valuation)\b/i;

/** News items that read like a funding announcement become kind 'funding'. */
export function classifyKind(defaultKind, title, summary = '') {
  return defaultKind === 'news' && FUNDING_RE.test(`${title} ${summary}`) ? 'funding' : defaultKind;
}

// Ordered: first matching rule wins. Proper nouns, case-sensitive on purpose.
export const REGION_RULES = [
  ['india', /\b(India|Indian|Bengaluru|Bangalore|Mumbai|Delhi|Hyderabad|Chennai|Pune|Gurugram|Gurgaon|Noida)\b/],
  ['europe', /\b(Europe|European|London|Berlin|Paris|Amsterdam|Stockholm|Madrid|Barcelona|Dublin|Munich|UK|Britain|British|German|French|Nordic)\b/],
  ['asia', /\b(Singapore|Indonesia|Jakarta|Vietnam|Hanoi|Philippines|Manila|Malaysia|Thailand|Bangkok|Japan|Tokyo|Korea|Seoul|China|Beijing|Shanghai|Shenzhen|Hong Kong|Taiwan|Southeast Asia|APAC)\b/],
  ['latam', /\b(Latin America|LatAm|Brazil|Brazilian|Mexico|Mexican|Colombia|Argentina|Chile|Peru|S[ãa]o Paulo|Bogot[áa]|Buenos Aires)\b/],
  ['africa', /\b(Africa|African|Nigeria|Lagos|Kenya|Nairobi|South Africa|Cape Town|Egypt|Cairo|Ghana|Accra)\b/],
];

export function classifyRegion(defaultRegion, text) {
  const haystack = String(text ?? '');
  for (const [region, re] of REGION_RULES) {
    if (re.test(haystack)) return region;
  }
  return defaultRegion;
}
