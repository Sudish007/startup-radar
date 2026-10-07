// Signal: Hugging Face models and spaces in the API's own trending order. The API's `trendingScore`
// field is never copied into the payload (only list position, likes and downloads are shown).

export const HF_MODELS_URL = 'https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=30';
export const HF_SPACES_URL = 'https://huggingface.co/api/spaces?sort=trendingScore&direction=-1&limit=30';

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

export function mapModel(m) {
  return {
    id: String(m.id ?? m.modelId ?? ''),
    url: `https://huggingface.co/${m.id ?? m.modelId}`,
    likes: num(m.likes),
    downloads: num(m.downloads),
    pipelineTag: str(m.pipeline_tag),
    library: str(m.library_name),
    createdAt: m.createdAt ?? null,
  };
}

export function mapSpace(s) {
  return {
    id: String(s.id ?? ''),
    url: `https://huggingface.co/spaces/${s.id}`,
    likes: num(s.likes),
    sdk: str(s.sdk),
    createdAt: s.createdAt ?? null,
  };
}

export function mapHf(models, spaces) {
  return {
    models: (Array.isArray(models) ? models : []).filter((m) => m && (m.id || m.modelId)).map(mapModel),
    spaces: (Array.isArray(spaces) ? spaces : []).filter((s) => s && s.id).map(mapSpace),
  };
}

export default {
  id: 'hf_trending',
  name: 'Hugging Face: trending',
  homepage: 'https://huggingface.co/models?sort=trending',
  description: "the first 30 entries of the Hugging Face API sorted by its own trending ranking; likes and downloads are the API's numbers",
  enabled: () => true,
  requires: null,
  async fetch(ctx) {
    const [models, spaces] = await Promise.all([
      ctx.http.fetchJson(HF_MODELS_URL, { signal: ctx.signal }),
      ctx.http.fetchJson(HF_SPACES_URL, { signal: ctx.signal }),
    ]);
    return mapHf(models, spaces);
  },
};
