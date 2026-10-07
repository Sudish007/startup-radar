// Signal: open SBIR/STTR solicitations. The public API answered HTTP 403 to this client during
// verification (plan §0.2 e): the adapter still tries every run and throws on failure, so the page shows
// the error plus `unavailable since`, with `homepage` (sbir.gov/topics) as the always-present link.

export const SBIR_API_URL = 'https://api.www.sbir.gov/public/api/solicitations?open=1';
export const MAX_SOLICITATIONS = 50;

function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export function mapSolicitation(s) {
  const due = Array.isArray(s.application_due_date) ? s.application_due_date.find((d) => typeof d === 'string') : null;
  return {
    title: str(s.solicitation_title) ?? str(s.title) ?? '(untitled)',
    agency: str(s.agency),
    closeDate: str(s.close_date) ?? str(due),
    url: str(s.sbir_solicitation_link) ?? str(s.solicitation_agency_url) ?? 'https://www.sbir.gov/topics',
  };
}

/** JSON array -> { solicitations: [<= 50] }; anything else throws (the runner records the error). */
export function mapSbir(body) {
  if (!Array.isArray(body)) throw new Error('SBIR API did not return a JSON array');
  return { solicitations: body.filter((s) => s && typeof s === 'object').slice(0, MAX_SOLICITATIONS).map(mapSolicitation) };
}

export default {
  id: 'sbir',
  name: 'SBIR/STTR open solicitations',
  homepage: 'https://www.sbir.gov/topics',
  description: 'open US SBIR/STTR solicitations (title, agency, close date) as listed by the sbir.gov public API; when the API is unavailable only the link is shown',
  enabled: () => true,
  requires: null,
  async fetch(ctx) {
    const body = await ctx.http.fetchJson(SBIR_API_URL, { signal: ctx.signal });
    return mapSbir(body);
  },
};
